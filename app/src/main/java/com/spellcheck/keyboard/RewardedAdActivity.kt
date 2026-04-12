package com.spellcheck.keyboard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback

class RewardedAdActivity : Activity() {

    private var rewardedAd: RewardedAd? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.transparent)
        CoroutineScope(Dispatchers.IO).launch {
            MobileAds.initialize(this@RewardedAdActivity)
        }
        loadAd()
    }

    private fun loadAd() {
        RewardedAd.load(
            this,
            AD_UNIT_ID,
            AdRequest.Builder().build(),
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) {
                    rewardedAd = ad
                    showAd()
                }
                override fun onAdFailedToLoad(error: LoadAdError) {
                    Toast.makeText(this@RewardedAdActivity, "광고를 불러올 수 없습니다.", Toast.LENGTH_SHORT).show()
                    finish()
                }
            }
        )
    }

    private fun showAd() {
        val ad = rewardedAd ?: run { finish(); return }
        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdDismissedFullScreenContent() { finish() }
            override fun onAdFailedToShowFullScreenContent(error: AdError) { finish() }
        }
        ad.show(this) { _ ->
            // 광고 완료 → 서버에 크레딧 충전 요청
            ApiClient.rewardAd(CreditsManager.deviceId) { result ->
                when (result) {
                    is ApiClient.Result.Success ->
                        CreditsManager.syncFromServer(result.text.toIntOrNull() ?: (CreditsManager.credits + 50))
                    else ->
                        CreditsManager.addCredits(50) // 서버 실패 시 로컬만 추가
                }
            }
        }
    }

    companion object {
        // TODO: 출시 전 AdMob 대시보드에서 실제 광고 단위 ID로 교체
        private const val AD_UNIT_ID = "ca-app-pub-6287915588339288/5175117899"

        fun start(context: Context) {
            context.startActivity(
                Intent(context, RewardedAdActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
            )
        }
    }
}
