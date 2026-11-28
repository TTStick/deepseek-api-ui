import Foundation

/// SQLite owns both the active history and the transactional import staging area.
/// Direct port of Android's `ChatStorage.java`; the wire protocol is identical.
final class ChatStorage {
    private static let databaseName = "chat-history.sqlite"
    private static let pageSize = 64
    private static let cleanupBatch = 256
    private static let migrationPending = 0
    private static let legacyCanRetire = 1
    private static let legacyRetired = 2
    private static let legacyRetained = 3
    private static let installedKey = "chat-storage.installed"

    private struct State {
        let slot: Int
        let token: String?
        let legacy: Int
        let revision: Int
        var staged: Int { 1 - slot }
    }

    private enum StorageError: Error {
        case stagingReplaced
        case migrationPending
        case missingStagingToken
        case revisionChanged
        case databaseMissing
        case missingState
        case unexpectedMigrationState
        case unknownOperation
    }

    private let queue = DispatchQueue(label: "io.github.wydeepseek.chat-storage")
    private let root: URL
    private let databaseURL: URL
    private let files: ChatFiles
    private var database: SQLiteDatabase?
    private var opened = false

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        root = support.appendingPathComponent("WyDeepSeek", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        databaseURL = root.appendingPathComponent(Self.databaseName)
        files = ChatFiles(root: root)
    }

    // MARK: - JS bridge entry point

    func request(method: String, payload: String) -> String {
        queue.sync {
            do {
                let args = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] ?? [:]
                let value = try execute(method: method, args: args)
                return Self.encode(["value": value ?? NSNull()])
            } catch {
                NSLog("ChatStorage %@ failed (%@)", method, String(describing: type(of: error)))
                return "{\"error\":\"Android chat storage operation failed\"}"
            }
        }
    }

    func attachmentData(_ token: String) throws -> Data {
        try queue.sync { try files.open(token) }
    }

    // MARK: - Database

    private func databaseOrThrow() throws -> SQLiteDatabase {
        let installed = UserDefaults.standard.bool(forKey: Self.installedKey)
        if installed && !FileManager.default.fileExists(atPath: databaseURL.path) {
            throw StorageError.databaseMissing
        }
        if let database {
            if !opened, installed, try readState(database).legacy == Self.migrationPending {
                throw StorageError.missingState
            }
            if !opened {
                try database.run("UPDATE state SET token=NULL WHERE id=1")
                opened = true
            }
            return database
        }
        let fresh = !FileManager.default.fileExists(atPath: databaseURL.path)
        let openedDatabase = try SQLiteDatabase(path: databaseURL.path)
        if fresh {
            try createSchema(openedDatabase)
        }
        database = openedDatabase
        if !opened {
            if installed, try readState(openedDatabase).legacy == Self.migrationPending {
                throw StorageError.missingState
            }
            try openedDatabase.run("UPDATE state SET token=NULL WHERE id=1")
            opened = true
        }
        return openedDatabase
    }

    private func createSchema(_ database: SQLiteDatabase) throws {
        try database.exec(
            """
            CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), slot INTEGER NOT NULL,
                token TEXT, legacy INTEGER NOT NULL, revision INTEGER NOT NULL);
            INSERT INTO state VALUES (1, 0, NULL, \(Self.legacyRetired), 0);
            CREATE TABLE sessions (slot INTEGER NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL, data BLOB NOT NULL,
                PRIMARY KEY(slot,id));
            CREATE TABLE refs (slot INTEGER NOT NULL, session TEXT NOT NULL, file TEXT NOT NULL,
                PRIMARY KEY(slot,session,file),
                FOREIGN KEY(slot,session) REFERENCES sessions(slot,id) ON DELETE CASCADE);
            CREATE INDEX refs_by_file ON refs(slot,file);
            CREATE TABLE files (slot INTEGER NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
                object TEXT NOT NULL, override INTEGER NOT NULL, PRIMARY KEY(slot,id));
            CREATE INDEX files_by_object ON files(object);
            CREATE TABLE garbage (object TEXT PRIMARY KEY);
            CREATE TRIGGER retired_file AFTER DELETE ON files BEGIN
                INSERT OR IGNORE INTO garbage VALUES (old.object); END;
            CREATE TRIGGER replaced_file AFTER UPDATE OF object ON files
                WHEN old.object<>new.object BEGIN
                INSERT OR IGNORE INTO garbage VALUES (old.object); END;
            """
        )
    }

    private func readState(_ database: SQLiteDatabase) throws -> State {
        guard let state = try database.first(
            "SELECT slot,token,legacy,revision FROM state WHERE id=1",
            [],
            { row in
                State(
                    slot: row.int(0),
                    token: row.string(1),
                    legacy: row.int(2),
                    revision: row.int(3)
                )
            }
        ) else {
            throw StorageError.missingState
        }
        return state
    }

    private func markInstalled() -> Bool {
        if UserDefaults.standard.bool(forKey: Self.installedKey) {
            return true
        }
        UserDefaults.standard.set(true, forKey: Self.installedKey)
        return true
    }

    // MARK: - Operations

    private func execute(method: String, args: [String: Any]) throws -> Any? {
        if method == "abandon" {
            files.abandon(args["object"] as? String ?? "")
            return nil
        }
        if method == "append" {
            guard let object = args["object"] as? String, let data = args["data"] as? String else {
                throw CocoaError(.fileWriteInvalidFileName)
            }
            try files.append(token: object, base64: data)
            return nil
        }

        let database = try databaseOrThrow()
        let state = try readState(database)
        let slot = state.slot
        let token = args["token"] as? String ?? ""
        if !token.isEmpty && token != state.token {
            if method == "discard" { return nil }
            throw StorageError.stagingReplaced
        }
        let target = token.isEmpty ? slot : state.staged
        let migrating = state.legacy == Self.migrationPending
        if migrating && token.isEmpty && method != "needsMigration" && method != "begin" {
            throw StorageError.migrationPending
        }

        switch method {
        case "needsMigration":
            if !migrating { _ = markInstalled() }
            return migrating

        case "retired":
            if state.legacy == Self.legacyCanRetire && markInstalled() {
                try database.run("UPDATE state SET legacy=? WHERE id=1", [Self.legacyRetired])
            }
            return nil

        case "upload":
            return try files.begin()

        case "canRetire":
            return state.legacy == Self.legacyCanRetire && markInstalled()

        case "summaries":
            return try readSummaries(database, slot: target, args: args)

        case "ids":
            return try readIds(database, slot: target, args: args)

        case "read":
            return try readSession(database, slot: target, id: args["id"] as? String ?? "")

        case "file":
            let id = args["id"] as? String ?? ""
            return try database.first(
                "SELECT object,type FROM files WHERE slot=? AND id=?",
                [target, id],
                { row in
                    [
                        "object": row.string(0) ?? "",
                        "type": row.string(1) ?? "",
                    ]
                }
            )

        case "fileTypes":
            let includeStaged = args["includeStaged"] as? Bool ?? false
            if includeStaged { try requireStaging(token) }
            return try readFileTypes(
                database,
                state: state,
                ids: args["ids"] as? [String] ?? [],
                includeStaged: includeStaged
            )

        case "begin":
            if migrating != (args["migration"] as? Bool ?? false) {
                throw StorageError.unexpectedMigrationState
            }
            let next = UUID().uuidString
            try database.transaction {
                try clearSlot(database, state.staged)
                try database.run("UPDATE state SET token=? WHERE id=1", [next])
            }
            return next

        case "revision":
            return String(state.revision)

        case "write":
            let hadFiles = try write(database, slot: target, token: token, args: args)
            if hadFiles { try maintain(database) }
            return nil

        case "remove":
            try remove(database, slot: target, token: token, id: args["id"] as? String ?? "")
            if token.isEmpty { try maintain(database) }
            return nil

        case "discard":
            try database.run("UPDATE state SET token=NULL WHERE token=?", [token])
            try maintain(database)
            return nil

        case "replace":
            try requireStaging(token)
            var legacy = state.legacy
            if migrating {
                legacy = (args["retainLegacy"] as? Bool ?? false) ? Self.legacyRetained : Self.legacyCanRetire
            } else if legacy == Self.legacyRetained {
                // An explicit full replacement also retires any previous recovery copy.
                legacy = Self.legacyCanRetire
            }
            try database.run(
                "UPDATE state SET slot=?,token=NULL,legacy=?,revision=revision+1 WHERE id=1",
                [state.staged, legacy]
            )
            if migrating { _ = markInstalled() }
            try clearSlot(database, state.slot)
            try maintain(database)
            return nil

        case "merge":
            try requireStaging(token)
            if String(state.revision) != (args["revision"] as? String ?? "") {
                throw StorageError.revisionChanged
            }
            try commitMerge(database, active: state.slot, staged: state.staged)
            try clearSlot(database, state.staged)
            try maintain(database)
            return nil

        default:
            throw StorageError.unknownOperation
        }
    }

    private func requireStaging(_ token: String) throws {
        if token.isEmpty { throw StorageError.missingStagingToken }
    }

    // MARK: - Reads

    private static func sessionPage(_ args: [String: Any]) -> String {
        " FROM sessions WHERE slot=?" + (args["after"] != nil ? " AND id>?" : "")
            + " ORDER BY id LIMIT \(pageSize)"
    }

    private static func pageKeys(_ slot: Int, _ args: [String: Any]) -> [Any?] {
        args["after"] != nil ? [slot, args["after"] as? String ?? ""] : [slot]
    }

    private func readIds(_ database: SQLiteDatabase, slot: Int, args: [String: Any]) throws -> [String] {
        try database.query(
            "SELECT id" + Self.sessionPage(args),
            Self.pageKeys(slot, args),
            { $0.string(0) ?? "" }
        )
    }

    private func readSummaries(_ database: SQLiteDatabase, slot: Int, args: [String: Any]) throws -> [[String: Any]] {
        try database.query(
            "SELECT id,created,updated,title" + Self.sessionPage(args),
            Self.pageKeys(slot, args),
            { row in
                [
                    "id": row.string(0) ?? "",
                    "createdAt": row.double(1),
                    "updatedAt": row.double(2),
                    "title": row.string(3) ?? "",
                ]
            }
        )
    }

    private func readSession(_ database: SQLiteDatabase, slot: Int, id: String) throws -> String? {
        let data: Data? = try database.first(
            "SELECT data FROM sessions WHERE slot=? AND id=?",
            [slot, id],
            { $0.blob(0) }
        ) ?? nil
        guard let data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func readFileTypes(
        _ database: SQLiteDatabase,
        state: State,
        ids: [String],
        includeStaged: Bool
    ) throws -> [[Any]] {
        let query = includeStaged
            ? "SELECT type FROM files WHERE id=? AND slot IN (?,?) "
                + "ORDER BY CASE WHEN slot=? AND override=1 THEN 0 WHEN slot=? THEN 1 ELSE 2 END LIMIT 1"
            : "SELECT type FROM files WHERE slot=? AND id=?"
        var types: [[Any]] = []
        for id in ids {
            let binds: [Any?] = includeStaged
                ? [id, state.slot, state.staged, state.staged, state.slot]
                : [state.slot, id]
            if let type = try database.first(query, binds, { $0.string(0) ?? "" }) {
                types.append([id, type])
            }
        }
        return types
    }

    // MARK: - Writes

    private func write(
        _ database: SQLiteDatabase,
        slot: Int,
        token: String,
        args: [String: Any]
    ) throws -> Bool {
        let attachments = args["files"] as? [[String: Any]] ?? []
        let sessions = args["sessions"] as? [[String: Any]] ?? []
        var objects: [String] = []
        for attachment in attachments {
            guard let object = attachment["object"] as? String else { continue }
            try files.prepare(token: object)
            objects.append(object)
        }
        if !objects.isEmpty {
            files.syncDirectory()
        }
        let overrideFiles = args["overrideFiles"] as? Bool ?? false
        let add = args["add"] as? Bool ?? false
        try database.transaction {
            for attachment in attachments {
                let id = attachment["id"] as? String ?? ""
                let type = attachment["type"] as? String ?? ""
                let object = attachment["object"] as? String ?? ""
                try database.run(
                    "UPDATE files SET type=?,object=?,override=? WHERE slot=? AND id=?",
                    [type, object, overrideFiles ? 1 : 0, slot, id]
                )
                if database.changes == 0 {
                    try database.run(
                        "INSERT INTO files (slot,id,type,object,override) VALUES (?,?,?,?,?)",
                        [slot, id, type, object, overrideFiles ? 1 : 0]
                    )
                }
            }
            for session in sessions {
                try writeSession(database, slot: slot, row: session, add: add)
            }
            if token.isEmpty {
                try bumpRevision(database)
            }
        }
        for object in objects {
            files.committed(object)
        }
        return !objects.isEmpty
    }

    private func writeSession(
        _ database: SQLiteDatabase,
        slot: Int,
        row: [String: Any],
        add: Bool
    ) throws {
        let id = row["id"] as? String ?? ""
        let title = row["title"] as? String ?? ""
        let created = row["createdAt"] as? Double ?? 0
        let updated = row["updatedAt"] as? Double ?? 0
        let data = Data((row["data"] as? String ?? "").utf8)
        try database.run(
            "UPDATE sessions SET title=?,created=?,updated=?,data=? WHERE slot=? AND id=?",
            [title, created, updated, data, slot, id]
        )
        if add || database.changes == 0 {
            try database.run(
                "INSERT INTO sessions (slot,id,title,created,updated,data) VALUES (?,?,?,?,?,?)",
                [slot, id, title, created, updated, data]
            )
        } else {
            try database.run("DELETE FROM refs WHERE slot=? AND session=?", [slot, id])
        }
        for file in row["fileIds"] as? [String] ?? [] {
            try database.run("INSERT INTO refs (slot,session,file) VALUES (?,?,?)", [slot, id, file])
        }
    }

    private func remove(_ database: SQLiteDatabase, slot: Int, token: String, id: String) throws {
        try database.transaction {
            if token.isEmpty {
                try database.run(
                    "DELETE FROM files WHERE slot=? AND id IN "
                        + "(SELECT file FROM refs WHERE slot=? AND session=?) AND NOT EXISTS "
                        + "(SELECT 1 FROM refs WHERE slot=files.slot AND file=files.id AND session<>?)",
                    [slot, slot, id, id]
                )
                try bumpRevision(database)
            }
            try database.run("DELETE FROM sessions WHERE slot=? AND id=?", [slot, id])
        }
    }

    private func commitMerge(_ database: SQLiteDatabase, active: Int, staged: Int) throws {
        try database.transaction {
            try database.run(
                "DELETE FROM sessions WHERE slot=? AND id IN (SELECT id FROM sessions WHERE slot=?)",
                [active, staged]
            )
            try database.run(
                "INSERT INTO sessions SELECT ?,id,title,created,updated,data FROM sessions WHERE slot=?",
                [active, staged]
            )
            try database.run(
                "INSERT INTO refs SELECT ?,session,file FROM refs WHERE slot=?",
                [active, staged]
            )
            try database.run(
                "INSERT OR IGNORE INTO files SELECT ?,id,type,object,0 FROM files WHERE slot=?",
                [active, staged]
            )
            try database.run(
                "UPDATE files SET type=(SELECT type FROM files AS src WHERE src.slot=? AND src.id=files.id),"
                    + " object=(SELECT object FROM files AS src WHERE src.slot=? AND src.id=files.id)"
                    + " WHERE slot=? AND id IN (SELECT id FROM files WHERE slot=? AND override=1)",
                [staged, staged, active, staged]
            )
            try database.run("UPDATE state SET token=NULL,revision=revision+1 WHERE id=1")
        }
    }

    private func bumpRevision(_ database: SQLiteDatabase) throws {
        try database.run("UPDATE state SET revision=revision+1 WHERE id=1")
    }

    private func clearSlot(_ database: SQLiteDatabase, _ slot: Int) throws {
        try database.run("DELETE FROM sessions WHERE slot=?", [slot])
        try database.run("DELETE FROM files WHERE slot=?", [slot])
    }

    // MARK: - Attachment cleanup

    private func maintain(_ database: SQLiteDatabase) throws {
        let candidates = files.candidates()
        if !candidates.isEmpty {
            try database.transaction {
                for object in candidates {
                    try database.run(
                        "INSERT OR IGNORE INTO garbage SELECT ? WHERE NOT EXISTS "
                            + "(SELECT 1 FROM files WHERE object=?)",
                        [object, object]
                    )
                }
            }
        }
        repeat {
            let removed = try collectGarbage(database)
            if removed < Self.cleanupBatch { break }
        } while true
    }

    /// Returns the number of garbage rows removed in this batch.
    private func collectGarbage(_ database: SQLiteDatabase) throws -> Int {
        let candidates: [String] = try database.query(
            "SELECT object FROM garbage WHERE NOT EXISTS "
                + "(SELECT 1 FROM files WHERE object=garbage.object) LIMIT \(Self.cleanupBatch)",
            [],
            { $0.string(0) ?? "" }
        )
        var removed = 0
        try database.transaction {
            try database.run(
                "DELETE FROM garbage WHERE EXISTS (SELECT 1 FROM files WHERE object=garbage.object)"
            )
            for object in candidates {
                if files.delete(object) {
                    try database.run("DELETE FROM garbage WHERE object=?", [object])
                    removed += 1
                }
            }
        }
        return removed
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]) else {
            return "{\"error\":\"encoding failed\"}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
