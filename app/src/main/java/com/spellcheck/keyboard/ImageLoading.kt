package com.spellcheck.keyboard

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri

fun decodeSampledBitmap(context: Context, path: String, reqWidth: Int, reqHeight: Int): Bitmap? {
    if (path.isBlank()) return null
    return try {
        if (path.startsWith("content://")) {
            decodeSampledBitmapFromBytes(
                context.contentResolver.openInputStream(Uri.parse(path))?.use { it.readBytes() },
                reqWidth,
                reqHeight
            )
        } else {
            decodeSampledBitmapFromFile(path, reqWidth, reqHeight)
        }
    } catch (_: Throwable) {
        null
    }
}

private fun decodeSampledBitmapFromFile(path: String, reqWidth: Int, reqHeight: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    return BitmapFactory.decodeFile(
        path,
        BitmapFactory.Options().apply {
            inSampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight, reqWidth, reqHeight)
            inPreferredConfig = Bitmap.Config.RGB_565
        }
    )
}

private fun decodeSampledBitmapFromBytes(bytes: ByteArray?, reqWidth: Int, reqHeight: Int): Bitmap? {
    if (bytes == null || bytes.isEmpty()) return null

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    return BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply {
            inSampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight, reqWidth, reqHeight)
            inPreferredConfig = Bitmap.Config.RGB_565
        }
    )
}

private fun calculateSampleSize(width: Int, height: Int, reqWidth: Int, reqHeight: Int): Int {
    var sampleSize = 1
    while (width / (sampleSize * 2) >= reqWidth && height / (sampleSize * 2) >= reqHeight) {
        sampleSize *= 2
    }
    return sampleSize.coerceAtLeast(1)
}
