package com.spellcheck.keyboard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas as ComposeCanvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class CropImageActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val imageUri = intent.getParcelableExtra<Uri>(EXTRA_IMAGE_URI)
        if (imageUri == null) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        setContent {
            MaterialTheme {
                Surface(color = Color(0xFF101114), modifier = Modifier.fillMaxSize()) {
                    CropImageScreen(
                        imageUri = imageUri,
                        onCancel = {
                            setResult(Activity.RESULT_CANCELED)
                            finish()
                        },
                        onConfirm = { bitmap ->
                            val path = saveCroppedBitmap(bitmap)
                            if (path != null) {
                                setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_RESULT_PATH, path))
                            } else {
                                setResult(Activity.RESULT_CANCELED)
                            }
                            finish()
                        }
                    )
                }
            }
        }
    }

    private fun saveCroppedBitmap(bitmap: Bitmap): String? {
        return try {
            filesDir.listFiles { f -> f.name.startsWith("custom_bg") }?.forEach { it.delete() }
            val file = File(filesDir, "custom_bg_${System.currentTimeMillis()}.jpg")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)
            }
            file.absolutePath
        } catch (_: Throwable) {
            null
        }
    }

    companion object {
        private const val EXTRA_IMAGE_URI = "image_uri"
        const val EXTRA_RESULT_PATH = "result_path"
        private const val KEYBOARD_BODY_HEIGHT_DP = 222f
        private const val CHROME_ROW_HEIGHT_DP = 36f

        private fun resolveTargetSize(context: Context): Pair<Int, Int> {
            SettingsManager.init(context)
            val density = context.resources.displayMetrics.density
            val layoutScale = KeyboardSizing.scaleFactor(context.resources.configuration)
            val fallbackWidth = context.resources.displayMetrics.widthPixels
            val fallbackHeight = (KEYBOARD_BODY_HEIGHT_DP * density * layoutScale).roundToInt()
            val bodyWidthPx = SettingsManager.keyboardBodyWidthPx.takeIf { it > 0 } ?: fallbackWidth
            val bodyHeightPx = SettingsManager.keyboardBodyHeightPx.takeIf { it > 0 } ?: fallbackHeight
            return bodyWidthPx to bodyHeightPx.coerceAtLeast(1)
        }

        fun computeAspectRatio(context: Context): Float {
            val (bodyWidthPx, bodyHeightPx) = resolveTargetSize(context)
            return bodyWidthPx.toFloat() / bodyHeightPx.toFloat()
        }

        fun computeOutputSize(context: Context): Pair<Int, Int> {
            val (bodyWidthPx, bodyHeightPx) = resolveTargetSize(context)
            return bodyWidthPx.coerceAtLeast(1) to bodyHeightPx.coerceAtLeast(1)
        }

        fun computeTopChromeCompensationPx(context: Context): Float {
            val density = context.resources.displayMetrics.density
            val layoutScale = KeyboardSizing.scaleFactor(context.resources.configuration)
            return CHROME_ROW_HEIGHT_DP * 2f * density * layoutScale
        }

        fun createIntent(context: Context, imageUri: Uri): Intent {
            return Intent(context, CropImageActivity::class.java).putExtra(EXTRA_IMAGE_URI, imageUri)
        }
    }
}

@Composable
private fun CropImageScreen(
    imageUri: Uri,
    onCancel: () -> Unit,
    onConfirm: (Bitmap) -> Unit
) {
    val context = LocalContext.current
    val cropAspectRatio = remember { CropImageActivity.computeAspectRatio(context) }
    val outputSize = remember { CropImageActivity.computeOutputSize(context) }
    val topChromeCompensationPx = remember { CropImageActivity.computeTopChromeCompensationPx(context) }
    val sourceBitmap by produceState<Bitmap?>(null, imageUri) {
        value = withContext(Dispatchers.IO) {
            decodeSampledBitmapFromUri(context, imageUri.toString(), 2400, 2400)
        }
    }

    var zoom by remember { mutableFloatStateOf(1f) }
    var rotation by remember { mutableFloatStateOf(0f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var cropSize by remember { mutableStateOf(Size.Zero) }
    var isSaving by remember { mutableStateOf(false) }

    LaunchedEffect(sourceBitmap) {
        zoom = 1f
        rotation = 0f
        offset = Offset.Zero
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF101114))
            .padding(20.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(
                onClick = onCancel,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF23262B))
            ) {
                Text("취소", color = Color.White)
            }
            Text("키보드 배경 자르기", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Button(
                onClick = {
                    val bitmap = sourceBitmap ?: return@Button
                    if (cropSize.width <= 0f || cropSize.height <= 0f) return@Button
                    isSaving = true
                    onConfirm(
                        renderCroppedBitmap(
                            source = bitmap,
                            cropWidthPx = cropSize.width,
                            cropHeightPx = cropSize.height,
                            zoom = zoom,
                            offset = offset,
                            topChromeCompensationPx = topChromeCompensationPx,
                            rotationDegrees = rotation,
                            outputWidth = outputSize.first,
                            outputHeight = outputSize.second
                        )
                    )
                },
                enabled = sourceBitmap != null && !isSaving,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0A84FF))
            ) {
                if (isSaving) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = Color.White,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text("적용", color = Color.White)
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        Text(
            "드래그로 위치를 맞추고, 핀치로 확대/축소하고, 회전 버튼으로 방향을 맞출 수 있어요.",
            color = Color.White.copy(alpha = 0.74f),
            fontSize = 13.sp
        )
        Spacer(Modifier.height(16.dp))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentAlignment = Alignment.Center
        ) {
            if (sourceBitmap == null) {
                CircularProgressIndicator(color = Color.White)
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(cropAspectRatio)
                        .clip(RoundedCornerShape(24.dp))
                        .background(Color.Black)
                ) {
                    ComposeCanvas(
                        modifier = Modifier
                            .fillMaxSize()
                            .pointerInput(sourceBitmap) {
                                detectTransformGestures { _, pan, gestureZoom, _ ->
                                    zoom = (zoom * gestureZoom).coerceIn(1f, 6f)
                                    offset += pan
                                }
                            }
                    ) {
                        cropSize = size
                        val bitmap = sourceBitmap!!.asImageBitmap()
                        val srcWidth = bitmap.width.toFloat()
                        val srcHeight = bitmap.height.toFloat()
                        val baseScale = max(size.width / srcWidth, size.height / srcHeight)

                        withTransform({
                            translate(size.width / 2f + offset.x, size.height / 2f + offset.y)
                            rotate(rotation, pivot = Offset.Zero)
                            scale(baseScale * zoom, baseScale * zoom)
                            translate(-srcWidth / 2f, -srcHeight / 2f)
                        }) {
                            drawImage(bitmap)
                        }

                        drawRect(
                            color = Color.White.copy(alpha = 0.9f),
                            style = Stroke(width = 3.dp.toPx())
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Button(
                onClick = { rotation -= 90f },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF23262B))
            ) {
                Text("왼쪽 회전", color = Color.White)
            }
            Button(
                onClick = {
                    zoom = 1f
                    rotation = 0f
                    offset = Offset.Zero
                },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF23262B))
            ) {
                Text("초기화", color = Color.White)
            }
            Button(
                onClick = { rotation += 90f },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF23262B))
            ) {
                Text("오른쪽 회전", color = Color.White)
            }
        }

        Spacer(Modifier.height(10.dp))
        Text(
            "선택 영역은 실제 키보드 바디 비율에 맞춰 표시됩니다.",
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
            color = Color.White.copy(alpha = 0.55f),
            fontSize = 12.sp
        )
    }
}

private fun renderCroppedBitmap(
    source: Bitmap,
    cropWidthPx: Float,
    cropHeightPx: Float,
    zoom: Float,
    offset: Offset,
    topChromeCompensationPx: Float,
    rotationDegrees: Float,
    outputWidth: Int,
    outputHeight: Int
): Bitmap {
    val viewportWidth = cropWidthPx.roundToInt().coerceAtLeast(1)
    val viewportHeight = cropHeightPx.roundToInt().coerceAtLeast(1)
    val viewportBitmap = Bitmap.createBitmap(viewportWidth, viewportHeight, Bitmap.Config.ARGB_8888)
    val viewportCanvas = Canvas(viewportBitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    val baseScale = max(cropWidthPx / source.width.toFloat(), cropHeightPx / source.height.toFloat())

    // First render exactly what the user sees inside the crop viewport.
    viewportCanvas.drawColor(android.graphics.Color.BLACK)
    viewportCanvas.translate(
        cropWidthPx / 2f + offset.x,
        cropHeightPx / 2f + offset.y - topChromeCompensationPx
    )
    viewportCanvas.rotate(rotationDegrees)
    viewportCanvas.scale(baseScale * zoom, baseScale * zoom)
    viewportCanvas.translate(-source.width / 2f, -source.height / 2f)
    viewportCanvas.drawBitmap(source, 0f, 0f, paint)

    if (viewportWidth == outputWidth && viewportHeight == outputHeight) {
        return viewportBitmap
    }

    val result = Bitmap.createBitmap(outputWidth, outputHeight, Bitmap.Config.ARGB_8888)
    val resultCanvas = Canvas(result)
    resultCanvas.drawBitmap(
        viewportBitmap,
        null,
        android.graphics.Rect(0, 0, outputWidth, outputHeight),
        paint
    )
    viewportBitmap.recycle()
    return result
}

private fun decodeSampledBitmapFromUri(
    context: Context,
    uriString: String,
    reqWidth: Int,
    reqHeight: Int
): Bitmap? {
    val uri = Uri.parse(uriString)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { input ->
        BitmapFactory.decodeStream(input, null, bounds)
    }

    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sampleSize = 1
    while (bounds.outWidth / sampleSize > reqWidth * 2 || bounds.outHeight / sampleSize > reqHeight * 2) {
        sampleSize *= 2
    }

    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize
        inPreferredConfig = Bitmap.Config.ARGB_8888
    }

    return context.contentResolver.openInputStream(uri)?.use { input ->
        BitmapFactory.decodeStream(input, null, options)
    }
}
