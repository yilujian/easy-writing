/**
 * 含标点的基础计数：去掉所有空白字符后按字符计数。
 * 已有 wordCount 字段始终保存该口径，不因用户切换显示方式而改变；
 * 不含标点的计数独立保存，避免污染历史基线。
 */
export const countWords = (text?: string | null) => String(text ?? '').replace(/\s+/g, '').length

/** 不含标点：仅计汉字、其他语言字母及数字，排除空白、标点和符号。 */
export const countTextWords = (text?: string | null) => String(text ?? '').replace(/[^\p{L}\p{N}]/gu, '').length
