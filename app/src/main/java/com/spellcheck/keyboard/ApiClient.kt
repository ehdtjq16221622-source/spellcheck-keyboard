package com.spellcheck.keyboard

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object ApiClient {

    private val API_KEY get() = BuildConfig.OPENAI_API_KEY
    private const val API_URL = "https://api.openai.com/v1/chat/completions"
    private const val MODEL = "gpt-4o-mini"

    private val executor = Executors.newSingleThreadExecutor()

    fun correct(
        text: String,
        formalMode: Boolean,
        includePunct: Boolean,
        includeDialect: Boolean,
        formalLevel: String,
        formalIncludePunct: Boolean,
        callback: (String) -> Unit
    ) {
        executor.execute {
            try {
                // 맞춤법 교정 기본 지시
                val baseInstruction = StringBuilder("다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정해주세요.")
                if (!includePunct) {
                    baseInstruction.append(" 중요: 쉼표(,)와 마침표(.)는 절대로 추가·삭제·변경하지 마세요. 원문의 구두점 위치와 종류를 그대로 유지하세요.")
                }
                if (includeDialect) {
                    baseInstruction.append(" 사투리 표현도 표준어로 교정해주세요.")
                }

                val prompt = if (formalMode) {
                    val effectivePunct = if (!formalIncludePunct) " 중요: 쉼표(,)와 마침표(.)는 절대로 추가·삭제·변경하지 마세요. 원문의 구두점을 그대로 유지하세요." else ""
                    when (formalLevel) {
                        "엄격 격식체" ->
                            "다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정하고, 격식체 존댓말(-습니다/-입니다 체)로 변환해주세요.$effectivePunct 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n$text"
                        "스마트 교정" ->
                            "다음 한국어 텍스트를 맞춤법을 교정하고, 전문적인 비즈니스 격식체로 자연스럽게 바꿔주세요.$effectivePunct 구어체·감탄사·비격식 표현을 정중하고 명확한 비즈니스 표현으로 바꾸되 원래 의미는 유지하세요. (예: '아 어머님들 애들이 공부를 안했는데' → '학부모님들, 자녀들의 학습 참여도가 저조한 상황입니다') 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n$text"
                        else -> // "적당한 존댓말"
                            "다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정하고, 자연스러운 존댓말(-요/-세요 체)로 변환해주세요.$effectivePunct 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n$text"
                    }
                } else {
                    "$baseInstruction 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n$text"
                }

                callback(callGPT(prompt))
            } catch (e: Exception) {
                callback("오류: ${e.message}")
            }
        }
    }

    fun translate(text: String, targetLang: String, callback: (String) -> Unit) {
        executor.execute {
            try {
                val langName = when (targetLang) {
                    "ko" -> "한국어"; "en" -> "영어"; "zh" -> "중국어(간체)"; "ja" -> "일본어"; else -> targetLang
                }
                val prompt = "다음 텍스트를 ${langName}로 번역해주세요. 번역된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n$text"
                callback(callGPT(prompt))
            } catch (e: Exception) {
                callback("번역 오류: ${e.message}")
            }
        }
    }

    private fun callGPT(prompt: String): String {
        val conn = URL(API_URL).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $API_KEY")
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 30000

        val body = JSONObject().apply {
            put("model", MODEL)
            put("temperature", 0.3)
            put("messages", JSONArray().apply {
                put(JSONObject().apply {
                    put("role", "user")
                    put("content", prompt)
                })
            })
        }

        OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

        return if (conn.responseCode == 200) {
            val response = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            JSONObject(response)
                .getJSONArray("choices")
                .getJSONObject(0)
                .getJSONObject("message")
                .getString("content")
                .trim()
        } else {
            val error = BufferedReader(InputStreamReader(conn.errorStream)).use { it.readText() }
            throw Exception("API 오류 (${conn.responseCode}): $error")
        }
    }
}
