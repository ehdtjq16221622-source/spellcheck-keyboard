package com.spellcheck.keyboard

class CheonjiinComposer {

    companion object {
        private val CHOSEONG = charArrayOf(
            'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ',
            'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
        )
        private val JUNGSEONG = charArrayOf(
            'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ',
            'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'
        )
        private val JONGSEONG = charArrayOf(
            0.toChar(), 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ',
            'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ',
            'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
        )
        private val CONSONANT_TO_CHO = mapOf(
            'ㄱ' to 0, 'ㄲ' to 1, 'ㄴ' to 2, 'ㄷ' to 3, 'ㄸ' to 4,
            'ㄹ' to 5, 'ㅁ' to 6, 'ㅂ' to 7, 'ㅃ' to 8, 'ㅅ' to 9,
            'ㅆ' to 10, 'ㅇ' to 11, 'ㅈ' to 12, 'ㅉ' to 13, 'ㅊ' to 14,
            'ㅋ' to 15, 'ㅌ' to 16, 'ㅍ' to 17, 'ㅎ' to 18
        )
        private val CONSONANT_TO_JONG = mapOf(
            'ㄱ' to 1, 'ㄲ' to 2, 'ㄴ' to 4, 'ㄷ' to 7, 'ㄹ' to 8,
            'ㅁ' to 16, 'ㅂ' to 17, 'ㅅ' to 19, 'ㅆ' to 20, 'ㅇ' to 21,
            'ㅈ' to 22, 'ㅊ' to 23, 'ㅋ' to 24, 'ㅌ' to 25, 'ㅍ' to 26, 'ㅎ' to 27
        )
        private val VOWEL_TO_JUNG = mapOf(
            'ㅏ' to 0, 'ㅐ' to 1, 'ㅑ' to 2, 'ㅒ' to 3, 'ㅓ' to 4,
            'ㅔ' to 5, 'ㅕ' to 6, 'ㅖ' to 7, 'ㅗ' to 8, 'ㅘ' to 9, 'ㅙ' to 10,
            'ㅚ' to 11, 'ㅛ' to 12, 'ㅜ' to 13, 'ㅝ' to 14, 'ㅞ' to 15, 'ㅟ' to 16,
            'ㅠ' to 17, 'ㅡ' to 18, 'ㅢ' to 19, 'ㅣ' to 20
        )
        private val SPLIT_JONG = mapOf(
            3 to Pair('ㄱ', 'ㅅ'), 5 to Pair('ㄴ', 'ㅈ'), 6 to Pair('ㄴ', 'ㅎ'),
            9 to Pair('ㄹ', 'ㄱ'), 10 to Pair('ㄹ', 'ㅁ'), 11 to Pair('ㄹ', 'ㅂ'),
            12 to Pair('ㄹ', 'ㅅ'), 13 to Pair('ㄹ', 'ㅌ'), 14 to Pair('ㄹ', 'ㅍ'),
            15 to Pair('ㄹ', 'ㅎ'), 18 to Pair('ㅂ', 'ㅅ')
        )
        private val COMPOUND_JONG = mapOf(
            Pair('ㄱ', 'ㅅ') to 3, Pair('ㄴ', 'ㅈ') to 5, Pair('ㄴ', 'ㅎ') to 6,
            Pair('ㄹ', 'ㄱ') to 9, Pair('ㄹ', 'ㅁ') to 10, Pair('ㄹ', 'ㅂ') to 11,
            Pair('ㄹ', 'ㅅ') to 12, Pair('ㄹ', 'ㅌ') to 13, Pair('ㄹ', 'ㅍ') to 14,
            Pair('ㄹ', 'ㅎ') to 15, Pair('ㅂ', 'ㅅ') to 18
        )

        // 천지인 모음 키 시퀀스 → 모음 문자
        // Samsung 기준: .(ㆍ)+ㅣ=ㅓ, ㅣ+.(ㆍ)=ㅏ
        val VOWEL_SEQ_MAP = mapOf(
            "ㅣ" to 'ㅣ',
            "ㅡ" to 'ㅡ',
            "ㆍㅣ" to 'ㅓ',
            "ㆍㅣㅣ" to 'ㅔ',
            "ㆍㆍㅣ" to 'ㅕ',
            "ㅣㆍ" to 'ㅏ',
            "ㅣㆍㅣ" to 'ㅐ',
            "ㅣㆍㆍ" to 'ㅑ',
            "ㆍㅡ" to 'ㅗ',
            "ㆍㆍㅡ" to 'ㅛ',
            "ㆍㅡㅣ" to 'ㅚ',
            "ㅡㆍ" to 'ㅜ',
            "ㅡㆍㆍ" to 'ㅠ',
            "ㅡㅣ" to 'ㅢ',
            "ㅣㆍㅡ" to 'ㅘ',
            "ㅣㆍㅡㅣ" to 'ㅙ',
            "ㅡㆍㅣ" to 'ㅟ',
            "ㅡㆍㅣㆍ" to 'ㅝ',
            "ㅡㆍㅣㆍㅣ" to 'ㅞ',
            // ㅜ(ㅡㆍ) + ㅓ(ㆍㅣ) 방식으로 입력해도 ㅝ 되도록 (대안 입력 경로)
            "ㅡㆍㆍㅣ" to 'ㅝ'
        )

        val VOWEL_KEYS = setOf('ㆍ', 'ㅡ', 'ㅣ')

        fun isValidPrefix(seq: String): Boolean =
            VOWEL_SEQ_MAP.keys.any { it.startsWith(seq) }

        fun compose(cho: Int, jung: Int, jong: Int = 0) =
            (0xAC00 + (cho * 21 + jung) * 28 + jong).toChar()
    }

    data class InputResult(val committed: String = "", val composing: Char? = null)

    private var cho = -1
    private var jung = -1
    private var jong = 0
    private var vowelSeq = ""

    fun isComposing() = cho >= 0 || jung >= 0 || vowelSeq.isNotEmpty()

    private fun getDisplayJung(): Int? {
        if (vowelSeq.isNotEmpty()) {
            val vowel = VOWEL_SEQ_MAP[vowelSeq] ?: return null
            return VOWEL_TO_JUNG[vowel]
        }
        return if (jung >= 0) jung else null
    }

    fun getCurrentChar(): Char? {
        val dJung = getDisplayJung()
        return when {
            cho >= 0 && dJung != null -> compose(cho, dJung, jong)
            cho >= 0 -> CHOSEONG[cho]
            dJung != null -> JUNGSEONG[dJung]
            vowelSeq.isNotEmpty() -> vowelSeq.last()
            else -> null
        }
    }

    fun input(key: Char): InputResult {
        return when {
            key in VOWEL_KEYS -> inputVowelKey(key)
            CONSONANT_TO_CHO.containsKey(key) -> inputConsonant(key)
            else -> {
                val committed = (getCurrentChar()?.toString() ?: "") + key
                reset()
                InputResult(committed = committed)
            }
        }
    }

    private fun inputVowelKey(key: Char): InputResult {
        // 받침이 있는 상태에서 모음이 오면 → 받침을 다음 글자의 초성으로 이동
        // 예: 안 + ㅣ = 아 + 니 (ㄴ이 다음 초성)
        if (cho >= 0 && jung >= 0 && jong > 0) {
            val committed: String
            val newCho: Char
            if (SPLIT_JONG.containsKey(jong)) {
                // 겹받침: 첫 번째는 받침 유지, 두 번째는 다음 초성
                val (first, second) = SPLIT_JONG[jong]!!
                val keptJong = CONSONANT_TO_JONG[first] ?: 0
                committed = compose(cho, jung, keptJong).toString()
                newCho = second
            } else {
                // 홑받침: 받침 제거 후 다음 초성으로
                committed = compose(cho, jung, 0).toString()
                newCho = JONGSEONG[jong]
            }
            reset()
            cho = CONSONANT_TO_CHO[newCho] ?: -1
            vowelSeq = key.toString()
            val vowel = VOWEL_SEQ_MAP[vowelSeq]
            if (vowel != null) jung = VOWEL_TO_JUNG[vowel] ?: -1
            return InputResult(committed = committed, composing = getCurrentChar())
        }

        val newSeq = vowelSeq + key
        return if (isValidPrefix(newSeq)) {
            vowelSeq = newSeq
            val vowel = VOWEL_SEQ_MAP[vowelSeq]
            if (vowel != null) jung = VOWEL_TO_JUNG[vowel] ?: -1
            InputResult(composing = getCurrentChar())
        } else {
            // 현재 상태 커밋 후 새 모음 시작
            val committed = commitFull()
            vowelSeq = key.toString()
            jung = VOWEL_TO_JUNG[VOWEL_SEQ_MAP[vowelSeq] ?: ' '] ?: -1
            InputResult(committed = committed, composing = getCurrentChar())
        }
    }

    private fun inputConsonant(consonant: Char): InputResult {
        // 모음 시퀀스 확정
        if (vowelSeq.isNotEmpty()) {
            jung = VOWEL_TO_JUNG[VOWEL_SEQ_MAP[vowelSeq] ?: ' '] ?: -1
            vowelSeq = ""
        }

        val choIdx = CONSONANT_TO_CHO[consonant] ?: return InputResult(committed = consonant.toString())
        val jongIdx = CONSONANT_TO_JONG[consonant]

        return when {
            cho >= 0 && jung >= 0 && jong == 0 && jongIdx != null -> {
                jong = jongIdx
                InputResult(composing = getCurrentChar())
            }
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
            cho >= 0 && jung < 0 -> {
                val committed = CHOSEONG[cho].toString()
                cho = choIdx
                InputResult(committed = committed, composing = getCurrentChar())
            }
            else -> {
                val committed = getCurrentChar()?.toString() ?: ""
                reset(); cho = choIdx
                InputResult(committed = committed, composing = getCurrentChar())
            }
        }
    }

    private fun commitFull(): String {
        val result = getCurrentChar()?.toString() ?: ""
        reset()
        return result
    }

    fun backspace(): InputResult {
        if (vowelSeq.isNotEmpty()) {
            vowelSeq = vowelSeq.dropLast(1)
            jung = if (vowelSeq.isNotEmpty()) VOWEL_TO_JUNG[VOWEL_SEQ_MAP[vowelSeq] ?: ' '] ?: -1 else -1
            return if (vowelSeq.isEmpty() && cho < 0) {
                InputResult(committed = "\b")
            } else {
                InputResult(composing = getCurrentChar())
            }
        }
        return when {
            jong > 0 && SPLIT_JONG.containsKey(jong) -> {
                val first = SPLIT_JONG[jong]!!.first
                jong = CONSONANT_TO_JONG[first] ?: 0
                InputResult(composing = getCurrentChar())
            }
            jong > 0 -> {
                jong = 0
                InputResult(composing = getCurrentChar())
            }
            jung >= 0 && cho >= 0 -> {
                jung = -1
                InputResult(composing = getCurrentChar())
            }
            else -> { reset(); InputResult(committed = "\b") }
        }
    }

    fun flush(): String {
        val result = getCurrentChar()?.toString() ?: ""
        reset()
        return result
    }

    // 천지인 SPACE: 받침이 있을 때 → 글자 확정만, 공백 미삽입
    // 받침 없으면 null 반환 → 일반 space 처리 (공백 삽입)
    fun flushIfJong(): String? {
        if (jong == 0) return null
        val committed = getCurrentChar()?.toString() ?: ""
        reset()
        return committed
    }

    private fun reset() { cho = -1; jung = -1; jong = 0; vowelSeq = "" }
}
