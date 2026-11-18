/**
 * Enter pressed in a text field to act on it (save, rename, search, send, pick), and not the Enter that confirms what
 * an input method (Japanese, Chinese, Korean…) is composing: that one has `isComposing`, or, in Safari, which ends
 * the composition before the key reaches the page, keyCode 229. Taken for a plain Enter it would save half a word.
 * Framework-free: a React key event or a DOM one.
 */
type KeyLike = { key: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } };

export const isEnter = (e: KeyLike): boolean => e.key === "Enter" && !(e.isComposing ?? e.nativeEvent?.isComposing) && e.keyCode !== 229;
