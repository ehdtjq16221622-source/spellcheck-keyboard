package com.spellcheck.keyboard

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object ApiClient {

    private const val BASE_URL = "https://ltjhlaprtjgmmijfnmri.supabase.co/functions/v1"
    private const val ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0amhsYXBydGpnbW1pamZubXJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyOTE5MzksImV4cCI6MjA4ODg2NzkzOX0.Z_lRI8GvajAwDTvDf0ny0w727CV0LXtinRgW-WpvmTo"

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
                val body = JSONObject().apply {
                    put("text", text)
                    put("formalMode", formalMode)
                    put("includePunct", includePunct)
                    put("includeDialect", includeDialect)
                    put("formalLevel", formalLevel)
                    put("formalIncludePunct", formalIncludePunct)
                }
                callback(callServer("correct", body))
            } catch (e: Exception) {
                callback("오류: ${e.message}")
            }
        }
    }

    fun translate(text: String, targetLang: String, callback: (String) -> Unit) {
        executor.execute {
            try {
                val body = JSONObject().apply {
                    put("text", text)
                    put("targetLang", targetLang)
                }
                callback(callServer("translate", body))
            } catch (e: Exception) {
                callback("번역 오류: ${e.message}")
            }
        }
    }

    private fun callServer(endpoint: String, body: JSONObject): String {
        val conn = URL("$BASE_URL/$endpoint").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $ANON_KEY")
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 30000

        OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

        return if (conn.responseCode == 200) {
            val response = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            JSONObject(response).getString("result")
        } else {
            val error = BufferedReader(InputStreamReader(conn.errorStream)).use { it.readText() }
            throw Exception("서버 오류 (${conn.responseCode}): $error")
        }
    }
}
