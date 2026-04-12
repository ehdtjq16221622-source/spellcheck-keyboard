package com.spellcheck.keyboard

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object ApiClient {

    data class CreditState(
        val freeCredits: Int,
        val paidCredits: Int
    ) {
        val totalCredits: Int get() = freeCredits + paidCredits
    }

    sealed class Result {
        data class Success(val text: String) : Result()
        data class Error(val message: String) : Result()
        data class NoCredits(val remaining: Int = 0) : Result()
    }

    sealed class SubscriptionSyncResult {
        data class Success(
            val active: Boolean,
            val expiryTimeMillis: Long?,
            val monthlyGrantApplied: Boolean
        ) : SubscriptionSyncResult()

        data class Error(val message: String) : SubscriptionSyncResult()
    }

    private const val BASE_URL = "https://ltjhlaprtjgmmijfnmri.supabase.co/functions/v1"
    private const val ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0amhsYXBydGpnbW1pamZubXJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyOTE5MzksImV4cCI6MjA4ODg2NzkzOX0.Z_lRI8GvajAwDTvDf0ny0w727CV0LXtinRgW-WpvmTo"

    private val executor = Executors.newSingleThreadExecutor()

    fun correct(
        text: String,
        formalMode: Boolean,
        includePunct: Boolean,
        includeDialect: Boolean,
        formalLevel: String,
        formalIncludePunct: Boolean,
        callback: (Result) -> Unit
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
                    put("deviceId", CreditsManager.deviceId)
                }
                val response = callServer("correct", body)
                parseAndSyncCredits(response)
                callback(Result.Success(response.getString("result")))
            } catch (e: NoCreditsException) {
                callback(Result.NoCredits(e.remaining))
            } catch (e: Exception) {
                callback(Result.Error(e.message ?: "맞춤법 교정에 실패했습니다."))
            }
        }
    }

    fun translate(text: String, targetLang: String, callback: (Result) -> Unit) {
        executor.execute {
            try {
                val body = JSONObject().apply {
                    put("text", text)
                    put("targetLang", targetLang)
                    put("deviceId", CreditsManager.deviceId)
                }
                val response = callServer("translate", body)
                parseAndSyncCredits(response)
                callback(Result.Success(response.getString("result")))
            } catch (e: NoCreditsException) {
                callback(Result.NoCredits(e.remaining))
            } catch (e: Exception) {
                callback(Result.Error(e.message ?: "번역에 실패했습니다."))
            }
        }
    }

    fun rewardAd(deviceId: String, callback: (Result) -> Unit) {
        executor.execute {
            try {
                val body = JSONObject().apply { put("deviceId", deviceId) }
                val response = callServer("reward_ad", body)
                val credits = parseAndSyncCredits(response)
                callback(Result.Success((credits?.totalCredits ?: CreditsManager.credits).toString()))
            } catch (e: Exception) {
                callback(Result.Error(e.message ?: "광고 보상 지급에 실패했습니다."))
            }
        }
    }

    fun syncSubscription(
        productId: String,
        purchaseToken: String,
        packageName: String,
        callback: (SubscriptionSyncResult) -> Unit
    ) {
        executor.execute {
            try {
                val body = JSONObject().apply {
                    put("deviceId", CreditsManager.deviceId)
                    put("productId", productId)
                    put("purchaseToken", purchaseToken)
                    put("packageName", packageName)
                }
                val response = callServer("sync_subscription", body)
                parseAndSyncCredits(response)
                callback(
                    SubscriptionSyncResult.Success(
                        active = response.optBoolean("subscription_active", false),
                        expiryTimeMillis = response.optLong("subscription_expiry_time_millis", 0L)
                            .takeIf { it > 0L },
                        monthlyGrantApplied = response.optBoolean("monthly_credit_granted", false)
                    )
                )
            } catch (e: Exception) {
                callback(SubscriptionSyncResult.Error(e.message ?: "구독 동기화에 실패했습니다."))
            }
        }
    }

    private class NoCreditsException(val remaining: Int) : Exception()

    private fun parseAndSyncCredits(response: JSONObject): CreditState? {
        val freeCredits = response.optInt("free_credits_remaining", -1)
        val paidCredits = response.optInt("paid_credits_remaining", -1)
        if (freeCredits >= 0 && paidCredits >= 0) {
            CreditsManager.syncFromServer(freeCredits, paidCredits)
            return CreditState(freeCredits, paidCredits)
        }

        val credits = response.optInt("credits_remaining", -1)
        if (credits >= 0) {
            CreditsManager.syncFromServer(credits)
            val total = CreditsManager.state.value
            return CreditState(total.freeCredits, total.paidCredits)
        }
        return null
    }

    private fun callServer(endpoint: String, body: JSONObject): JSONObject {
        val conn = URL("$BASE_URL/$endpoint").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $ANON_KEY")
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 30000

        OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

        return if (conn.responseCode == 200) {
            val raw = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            JSONObject(raw)
        } else if (conn.responseCode == 429) {
            val raw = conn.errorStream?.let {
                BufferedReader(InputStreamReader(it)).use { reader -> reader.readText() }
            } ?: "{}"
            val obj = JSONObject(raw)
            throw NoCreditsException(obj.optInt("remaining", 0))
        } else {
            val error = conn.errorStream?.let {
                BufferedReader(InputStreamReader(it)).use { reader -> reader.readText() }
            } ?: "Unknown error"
            throw Exception("서버 오류 (${conn.responseCode}): $error")
        }
    }
}
