import styles from './Toggle.module.css'

/** 开关（aria-switch）：设置页通用开关按钮 */
export const Toggle = ({
  pressed,
  label,
  onChange,
}: {
  pressed: boolean
  label: string
  onChange: (value: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={pressed}
    aria-label={label}
    className={styles.switch}
    onClick={() => onChange(!pressed)}
  >
    <span className={styles.track}>
      <span className={styles.thumb} />
    </span>
  </button>
)
