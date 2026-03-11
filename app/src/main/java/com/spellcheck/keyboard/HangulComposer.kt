package com.spellcheck.keyboard

/**
 * 두벌식 한글 조합기
 * 자음/모음 입력을 받아 완성형 한글 음절로 조합
 */
class HangulComposer {

    companion object {
        // 초성 (19개)
        private val CHOSEONG = charArrayOf(
            'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ',
            'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
        )
        // 중성 (21개)
        private val JUNGSEONG = charArrayOf(
            'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ',
            'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'
        )
        // 종성 (28개, 0번째는 없음)
        private val JONGSEONG = charArrayOf(
            0.toChar(), 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ',
            'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ',
            'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
        )
        // 자음 → 초성 인덱스
        private val CONSONANT_TO_CHO = mapOf(
            'ㄱ' to 0, 'ㄲ' to 1, 'ㄴ' to 2, 'ㄷ' to 3, 'ㄸ' to 4,
            'ㄹ' to 5, 'ㅁ' to 6, 'ㅂ' to 7, 'ㅃ' to 8, 'ㅅ' to 9,
            'ㅆ' to 10, 'ㅇ' to 11, 'ㅈ' to 12, 'ㅉ' to 13, 'ㅊ' to 14,
            'ㅋ' to 15, 'ㅌ' to 16, 'ㅍ' to 17, 'ㅎ' to 18
        )
        // 자음 → 종성 인덱스
        private val CONSONANT_TO_JONG = mapOf(
            'ㄱ' to 1, 'ㄲ' to 2, 'ㄴ' to 4, 'ㄷ' to 7, 'ㄹ' to 8,
            'ㅁ' to 16, 'ㅂ' to 17, 'ㅅ' to 19, 'ㅆ' to 20, 'ㅇ' to 21,
            'ㅈ' to 22, 'ㅊ' to 23, 'ㅋ' to 24, 'ㅌ' to 25, 'ㅍ' to 26, 'ㅎ' to 27
        )
        // 모음 → 중성 인덱스
        private val VOWEL_TO_JUNG = mapOf(
            'ㅏ' to 0, 'ㅐ' to 1, 'ㅑ' to 2, 'ㅒ' to 3, 'ㅓ' to 4,
            'ㅔ' to 5, 'ㅕ' to 6, 'ㅖ' to 7, 'ㅗ' to 8, 'ㅛ' to 12,
            'ㅜ' to 13, 'ㅠ' to 17, 'ㅡ' to 18, 'ㅢ' to 19, 'ㅣ' to 20
        )
        // 복합 모음 (ㅗ+ㅏ=ㅘ 등)
        private val COMPOUND_VOWEL = mapOf(
            Pair('ㅗ', 'ㅏ') to 'ㅘ', Pair('ㅗ', 'ㅐ') to 'ㅙ', Pair('ㅗ', 'ㅣ') to 'ㅚ',
            Pair('ㅜ', 'ㅓ') to 'ㅝ', Pair('ㅜ', 'ㅔ') to 'ㅞ', Pair('ㅜ', 'ㅣ') to 'ㅟ',
            Pair('ㅡ', 'ㅣ') to 'ㅢ'
        )
        // 복합 종성 (ㄱ+ㅅ=ㄳ 등)
        private val COMPOUND_JONG = mapOf(
            Pair('ㄱ', 'ㅅ') to 3, Pair('ㄴ', 'ㅈ') to 5, Pair('ㄴ', 'ㅎ') to 6,
            Pair('ㄹ', 'ㄱ') to 9, Pair('ㄹ', 'ㅁ') to 10, Pair('ㄹ', 'ㅂ') to 11,
            Pair('ㄹ', 'ㅅ') to 12, Pair('ㄹ', 'ㅌ') to 13, Pair('ㄹ', 'ㅍ') to 14,
            Pair('ㄹ', 'ㅎ') to 15, Pair('ㅂ', 'ㅅ') to 18
        )
        // 복합 종성 분리 (ㄳ → ㄱ, ㅅ)
        private val SPLIT_JONG = mapOf(
            3 to Pair('ㄱ', 'ㅅ'), 5 to Pair('ㄴ', 'ㅈ'), 6 to Pair('ㄴ', 'ㅎ'),
            9 to Pair('ㄹ', 'ㄱ'), 10 to Pair('ㄹ', 'ㅁ'), 11 to Pair('ㄹ', 'ㅂ'),
            12 to Pair('ㄹ', 'ㅅ'), 13 to Pair('ㄹ', 'ㅌ'), 14 to Pair('ㄹ', 'ㅍ'),
            15 to Pair('ㄹ', 'ㅎ'), 18 to Pair('ㅂ', 'ㅅ')
        )

        fun isVowel(c: Char) = c in VOWEL_TO_JUNG
        fun isConsonant(c: Char) = c in CONSONANT_TO_CHO
        fun compose(cho: Int, jung: Int, jong: Int = 0) =
            (0xAC00 + (cho * 21 + jung) * 28 + jong).toChar()
    }

    data class InputResult(val committed: String = "", val composing: Char? = null)

    private var cho = -1
    private var jung = -1
    private var jong = 0

    fun isComposing() = cho >= 0 || jung >= 0

    fun getCurrentChar(): Char? = when {
        cho >= 0 && jung >= 0 -> compose(cho, jung, jong)
        cho >= 0 -> CHOSEONG[cho]
        jung >= 0 -> JUNGSEONG[jung]
        else -> null
    }

    fun input(jamo: Char): InputResult {
        if (isVowel(jamo)) return inputVowel(jamo)
        if (isConsonant(jamo)) return inputConsonant(jamo)
        val committed = (getCurrentChar()?.toString() ?: "") + jamo
        reset()
        return InputResult(committed = committed)
    }

    private fun inputVowel(vowel: Char): InputResult {
        val vIdx = VOWEL_TO_JUNG[vowel] ?: return InputResult(committed = vowel.toString())

        return when {
            // 초성만 있음 → 초성+중성 조합
            cho >= 0 && jung < 0 -> {
                jung = vIdx
                InputResult(composing = getCurrentChar())
            }
            // 초성+중성+종성 → 종성 분리 후 새 음절 시작
            cho >= 0 && jung >= 0 && jong > 0 -> {
                val split = SPLIT_JONG[jong]
                if (split != null) {
                    val remainJong = CONSONANT_TO_JONG[split.first] ?: 0
                    val committed = compose(cho, jung, remainJong).toString()
                    cho = CONSONANT_TO_CHO[split.second] ?: 0
                    jung = vIdx
                    jong = 0
                    InputResult(committed = committed, composing = getCurrentChar())
                } else {
                    val jongChar = JONGSEONG[jong]
                    val committed = compose(cho, jung, 0).toString()
                    cho = CONSONANT_TO_CHO[jongChar] ?: -1
                    jung = vIdx
                    jong = 0
                    InputResult(committed = committed, composing = getCurrentChar())
                }
            }
            // 초성+중성 → 복합 모음 시도
            cho >= 0 && jung >= 0 && jong == 0 -> {
                val currentVowel = JUNGSEONG[jung]
                val compound = COMPOUND_VOWEL[Pair(currentVowel, vowel)]
                if (compound != null) {
                    jung = VOWEL_TO_JUNG[compound] ?: vIdx
                    InputResult(composing = getCurrentChar())
                } else {
                    val committed = compose(cho, jung).toString()
                    cho = -1; jung = vIdx; jong = 0
                    InputResult(committed = committed, composing = getCurrentChar())
                }
            }
            // 아무것도 없음 → 모음 단독
            else -> {
                val committed = getCurrentChar()?.toString() ?: ""
                reset()
                jung = vIdx
                InputResult(committed = committed, composing = getCurrentChar())
            }
        }
    }

    private fun inputConsonant(consonant: Char): InputResult {
        val choIdx = CONSONANT_TO_CHO[consonant] ?: return InputResult(committed = consonant.toString())
        val jongIdx = CONSONANT_TO_JONG[consonant]

        return when {
            // 초성+중성, 종성 없음 → 종성 후보
            cho >= 0 && jung >= 0 && jong == 0 && jongIdx != null -> {
                jong = jongIdx
                InputResult(composing = getCurrentChar())
            }
            // 초성+중성+종성 → 복합 종성 시도 or 새 음절
            cho >= 0 && jung >= 0 && jong > 0 -> {
                val jongChar = JONGSEONG[jong]
                val compound = COMPOUND_JONG[Pair(jongChar, consonant)]
                if (compound != null) {
                    jong = compound
                    InputResult(composing = getCurrentChar())
                } else {
                    val committed = compose(cho, jung, jong).toString()
                    reset(); cho = choIdx
                    InputResult(committed = committed, composing = getCurrentChar())
                }
            }
            // 초성만 있음 → 이전 확정 후 새 초성
            cho >= 0 && jung < 0 -> {
                val committed = CHOSEONG[cho].toString()
                cho = choIdx
                InputResult(committed = committed, composing = getCurrentChar())
            }
            // 아무것도 없음 → 초성 시작
            else -> {
                val committed = getCurrentChar()?.toString() ?: ""
                reset(); cho = choIdx
                InputResult(committed = committed, composing = getCurrentChar())
            }
        }
    }

    fun backspace(): InputResult {
        return when {
            // 복합 종성 → 첫 자음만 남김
            jong > 0 && SPLIT_JONG.containsKey(jong) -> {
                val first = SPLIT_JONG[jong]!!.first
                jong = CONSONANT_TO_JONG[first] ?: 0
                InputResult(composing = getCurrentChar())
            }
            // 종성 제거
            jong > 0 -> {
                jong = 0
                InputResult(composing = getCurrentChar())
            }
            // 중성 제거
            jung >= 0 && cho >= 0 -> {
                jung = -1
                InputResult(composing = getCurrentChar())
            }
            // 초성만 → 전체 삭제
            else -> { reset(); InputResult(committed = "\b") }
        }
    }

    fun flush(): String {
        val result = getCurrentChar()?.toString() ?: ""
        reset()
        return result
    }

    // 쌍자음 두 번 연속 입력용
    fun isComposingConsonantOnly() = cho >= 0 && jung < 0 && jong == 0

    fun upgradeToDouble(doubled: Char): InputResult {
        val choIdx = CONSONANT_TO_CHO[doubled] ?: return InputResult()
        cho = choIdx
        return InputResult(composing = getCurrentChar())
    }

    private fun reset() { cho = -1; jung = -1; jong = 0 }
}
