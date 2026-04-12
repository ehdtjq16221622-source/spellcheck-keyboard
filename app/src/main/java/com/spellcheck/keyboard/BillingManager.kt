package com.spellcheck.keyboard

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object BillingManager : PurchasesUpdatedListener {

    data class UiState(
        val isConnecting: Boolean = false,
        val isProductReady: Boolean = false,
        val isPlan2Ready: Boolean = false,
        val isPurchaseInProgress: Boolean = false,
        val isPurchasePending: Boolean = false,
        val isSyncing: Boolean = false,
        val productPrice: String? = null,
        val productName: String? = null,
        val plan2Price: String? = null,
        val plan2Name: String? = null
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingActions = ArrayDeque<() -> Unit>()
    private val syncingTokens = mutableSetOf<String>()
    private val _state = MutableStateFlow(UiState())

    private var appContext: Context? = null
    private var billingClient: BillingClient? = null
    private var productDetails: ProductDetails? = null
    private var offerToken: String? = null
    private var productDetails2: ProductDetails? = null
    private var offerToken2: String? = null
    private var isConnecting = false

    val state: StateFlow<UiState> = _state.asStateFlow()

    fun init(context: Context) {
        appContext = context.applicationContext
        if (billingClient == null) {
            billingClient = BillingClient.newBuilder(appContext!!)
                .setListener(this)
                .enablePendingPurchases(
                    PendingPurchasesParams.newBuilder()
                        .enableOneTimeProducts()
                        .build()
                )
                .enableAutoServiceReconnection()
                .build()
        }
        refresh()
    }

    fun refresh() {
        runWhenReady {
            queryProductDetails()
            queryActiveSubscriptions()
        }
    }

    fun launchSubscriptionPurchase(activity: Activity, plan: Int = 1) {
        runWhenReady {
            val readyProduct = if (plan == 2) productDetails2 else productDetails
            val readyOfferToken = if (plan == 2) offerToken2 else offerToken
            if (readyProduct == null || readyOfferToken == null) {
                toast("구독 상품 정보를 아직 불러오지 못했습니다.")
                queryProductDetails()
                return@runWhenReady
            }

            val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(readyProduct)
                .setOfferToken(readyOfferToken)
                .build()

            val params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productParams))
                .setObfuscatedAccountId(CreditsManager.deviceId)
                .build()

            updateState { it.copy(isPurchaseInProgress = true) }
            val result = billingClient?.launchBillingFlow(activity, params)
            if (result?.responseCode != BillingClient.BillingResponseCode.OK) {
                updateState { it.copy(isPurchaseInProgress = false) }
                toast(result?.debugMessage ?: "결제창을 열지 못했습니다.")
            }
        }
    }

    fun openSubscriptionManagement(context: Context) {
        val uri = Uri.parse(
            "https://play.google.com/store/account/subscriptions" +
                "?sku=${BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID}" +
                "&package=${BuildConfig.APPLICATION_ID}"
        )
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toast("Google Play를 열 수 없습니다.")
        }
    }

    override fun onPurchasesUpdated(
        billingResult: BillingResult,
        purchases: MutableList<Purchase>?
    ) {
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                updateState { it.copy(isPurchaseInProgress = false, isPurchasePending = false) }
                if (!purchases.isNullOrEmpty()) {
                    processPurchases(purchases, clearWhenEmpty = false)
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                updateState { it.copy(isPurchaseInProgress = false) }
            }
            else -> {
                updateState { it.copy(isPurchaseInProgress = false) }
                toast(billingResult.debugMessage.ifBlank { "구독 결제를 처리하지 못했습니다." })
            }
        }
    }

    private fun runWhenReady(action: () -> Unit) {
        val client = billingClient
        if (client != null && client.isReady) {
            action()
            return
        }

        pendingActions.addLast(action)
        if (isConnecting) {
            return
        }

        isConnecting = true
        updateState { it.copy(isConnecting = true) }
        billingClient?.startConnection(object : BillingClientStateListener {
            override fun onBillingServiceDisconnected() {
                isConnecting = false
                updateState { it.copy(isConnecting = false) }
            }

            override fun onBillingSetupFinished(billingResult: BillingResult) {
                isConnecting = false
                updateState { it.copy(isConnecting = false) }
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    while (pendingActions.isNotEmpty()) {
                        pendingActions.removeFirst().invoke()
                    }
                } else {
                    pendingActions.clear()
                    toast(billingResult.debugMessage.ifBlank { "Google Play 결제 연결에 실패했습니다." })
                }
            }
        })
    }

    private fun queryProductDetails() {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build(),
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID_PLAN2)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build()
                )
            )
            .build()

        billingClient?.queryProductDetailsAsync(params) { billingResult, queryResult ->
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                toast(billingResult.debugMessage.ifBlank { "구독 상품 정보를 불러오지 못했습니다." })
                return@queryProductDetailsAsync
            }

            val plan1 = queryResult.productDetailsList.firstOrNull {
                it.productId == BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID
            }
            val plan2 = queryResult.productDetailsList.firstOrNull {
                it.productId == BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID_PLAN2
            }

            val offer1 = plan1?.subscriptionOfferDetails?.firstOrNull()
            val offer2 = plan2?.subscriptionOfferDetails?.firstOrNull()

            productDetails = plan1
            offerToken = offer1?.offerToken
            productDetails2 = plan2
            offerToken2 = offer2?.offerToken

            updateState {
                it.copy(
                    isProductReady = plan1 != null && offer1 != null,
                    isPlan2Ready = plan2 != null && offer2 != null,
                    productPrice = offer1?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice,
                    productName = plan1?.title,
                    plan2Price = offer2?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice,
                    plan2Name = plan2?.title
                )
            }
        }
    }

    private fun queryActiveSubscriptions() {
        val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.SUBS)
            .build()

        billingClient?.queryPurchasesAsync(params) { billingResult, purchases ->
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                toast(billingResult.debugMessage.ifBlank { "구독 상태를 확인하지 못했습니다." })
                return@queryPurchasesAsync
            }
            processPurchases(purchases, clearWhenEmpty = true)
        }
    }

    private fun processPurchases(purchases: List<Purchase>, clearWhenEmpty: Boolean) {
        val matchingPurchases = purchases.filter { purchase ->
            purchase.products.contains(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID) ||
                purchase.products.contains(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID_PLAN2)
        }

        if (matchingPurchases.isEmpty()) {
            if (clearWhenEmpty) {
                TrialManager.clearSubscription()
            }
            updateState { it.copy(isPurchasePending = false, isSyncing = false) }
            return
        }

        var hasPending = false
        matchingPurchases.forEach { purchase ->
            when (purchase.purchaseState) {
                Purchase.PurchaseState.PURCHASED -> acknowledgeAndSync(purchase)
                Purchase.PurchaseState.PENDING -> hasPending = true
                else -> Unit
            }
        }

        updateState { it.copy(isPurchasePending = hasPending) }
    }

    private fun acknowledgeAndSync(purchase: Purchase) {
        if (purchase.isAcknowledged) {
            syncPurchase(purchase)
            return
        }

        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()

        billingClient?.acknowledgePurchase(params) { billingResult ->
            if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                syncPurchase(purchase)
            } else {
                updateState { it.copy(isPurchaseInProgress = false) }
                toast(billingResult.debugMessage.ifBlank { "구독 승인에 실패했습니다." })
            }
        }
    }

    private fun syncPurchase(purchase: Purchase) {
        val purchaseToken = purchase.purchaseToken
        if (!syncingTokens.add(purchaseToken)) {
            return
        }

        updateState { it.copy(isSyncing = true, isPurchaseInProgress = false) }
        ApiClient.syncSubscription(
            productId = purchase.products.firstOrNull() ?: BuildConfig.PLAY_SUBSCRIPTION_PRODUCT_ID,
            purchaseToken = purchaseToken,
            packageName = BuildConfig.APPLICATION_ID
        ) { result ->
            mainHandler.post {
                syncingTokens.remove(purchaseToken)
                when (result) {
                    is ApiClient.SubscriptionSyncResult.Success -> {
                        TrialManager.setSubscription(
                            active = result.active,
                            expiryTimeMillis = result.expiryTimeMillis
                        )
                        updateState {
                            it.copy(
                                isSyncing = false,
                                isPurchaseInProgress = false,
                                isPurchasePending = false
                            )
                        }
                        if (result.monthlyGrantApplied) {
                            toast("구독 크레딧이 지급되었습니다.")
                        }
                    }
                    is ApiClient.SubscriptionSyncResult.Error -> {
                        updateState {
                            it.copy(
                                isSyncing = false,
                                isPurchaseInProgress = false
                            )
                        }
                        toast(result.message)
                    }
                }
            }
        }
    }

    private fun toast(message: String) {
        val context = appContext ?: return
        mainHandler.post {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateState(transform: (UiState) -> UiState) {
        mainHandler.post {
            _state.value = transform(_state.value)
        }
    }
}
