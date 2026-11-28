import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLiteError: Error, CustomStringConvertible {
    case open(String)
    case prepare(String, String)
    case step(String, String)
    case execute(String, String)

    var description: String {
        switch self {
        case let .open(message): return "open: \(message)"
        case let .prepare(sql, message): return "prepare \(sql): \(message)"
        case let .step(sql, message): return "step \(sql): \(message)"
        case let .execute(sql, message): return "exec \(sql): \(message)"
        }
    }
}

final class SQLiteStatement {
    let handle: OpaquePointer
    private let sql: String

    init(handle: OpaquePointer, sql: String) {
        self.handle = handle
        self.sql = sql
    }

    deinit {
        sqlite3_finalize(handle)
    }

    func bind(_ values: [Any?]) throws {
        sqlite3_reset(handle)
        sqlite3_clear_bindings(handle)
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case nil, is NSNull:
                sqlite3_bind_null(handle, position)
            case let value as String:
                sqlite3_bind_text(handle, position, value, -1, sqliteTransient)
            case let value as Data:
                value.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(handle, position, buffer.baseAddress, Int32(value.count), sqliteTransient)
                }
            case let value as Bool:
                sqlite3_bind_int64(handle, position, value ? 1 : 0)
            case let value as Int:
                sqlite3_bind_int64(handle, position, Int64(value))
            case let value as Int64:
                sqlite3_bind_int64(handle, position, value)
            case let value as Double:
                sqlite3_bind_double(handle, position, value)
            default:
                sqlite3_bind_text(handle, position, String(describing: value), -1, sqliteTransient)
            }
        }
    }

    /// Returns true when a row is available.
    func step() throws -> Bool {
        let result = sqlite3_step(handle)
        if result == SQLITE_ROW { return true }
        if result == SQLITE_DONE { return false }
        throw SQLiteError.step(sql, String(cString: sqlite3_errmsg(sqlite3_db_handle(handle))))
    }

    func int(_ index: Int32) -> Int {
        Int(sqlite3_column_int64(handle, index))
    }

    func int64(_ index: Int32) -> Int64 {
        sqlite3_column_int64(handle, index)
    }

    func double(_ index: Int32) -> Double {
        sqlite3_column_double(handle, index)
    }

    func string(_ index: Int32) -> String? {
        guard sqlite3_column_type(handle, index) != SQLITE_NULL,
              let pointer = sqlite3_column_text(handle, index) else { return nil }
        return String(cString: pointer)
    }

    func blob(_ index: Int32) -> Data? {
        guard sqlite3_column_type(handle, index) != SQLITE_NULL else { return nil }
        guard let pointer = sqlite3_column_blob(handle, index) else { return Data() }
        let count = Int(sqlite3_column_bytes(handle, index))
        return Data(bytes: pointer, count: count)
    }

    func isNull(_ index: Int32) -> Bool {
        sqlite3_column_type(handle, index) == SQLITE_NULL
    }

    func reset() {
        sqlite3_reset(handle)
    }
}

final class SQLiteDatabase {
    private var handle: OpaquePointer?

    init(path: String) throws {
        var database: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let status = sqlite3_open_v2(path, &database, flags, nil)
        guard status == SQLITE_OK, let database else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            if let database { sqlite3_close(database) }
            throw SQLiteError.open(message)
        }
        handle = database
        sqlite3_busy_timeout(database, 5_000)
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA synchronous=FULL")
        try exec("PRAGMA foreign_keys=ON")
    }

    deinit {
        if let handle {
            sqlite3_close(handle)
        }
    }

    func exec(_ sql: String) throws {
        guard let handle else { throw SQLiteError.execute(sql, "database is closed") }
        var error: UnsafeMutablePointer<CChar>?
        let status = sqlite3_exec(handle, sql, nil, nil, &error)
        if status != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(error)
            throw SQLiteError.execute(sql, message)
        }
    }

    var changes: Int {
        guard let handle else { return 0 }
        return Int(sqlite3_changes(handle))
    }

    func prepare(_ sql: String) throws -> SQLiteStatement {
        guard let handle else { throw SQLiteError.prepare(sql, "database is closed") }
        var statement: OpaquePointer?
        let status = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard status == SQLITE_OK, let statement else {
            throw SQLiteError.prepare(sql, String(cString: sqlite3_errmsg(handle)))
        }
        return SQLiteStatement(handle: statement, sql: sql)
    }

    func run(_ sql: String, _ values: [Any?] = []) throws {
        let statement = try prepare(sql)
        try statement.bind(values)
        while try statement.step() {}
    }

    func query<T>(_ sql: String, _ values: [Any?] = [], _ map: (SQLiteStatement) throws -> T) throws -> [T] {
        let statement = try prepare(sql)
        try statement.bind(values)
        var rows: [T] = []
        while try statement.step() {
            rows.append(try map(statement))
        }
        return rows
    }

    func first<T>(_ sql: String, _ values: [Any?] = [], _ map: (SQLiteStatement) throws -> T) throws -> T? {
        try query(sql, values, map).first
    }

    func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE")
        do {
            try body()
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }
}
