package com.spellcheck.keyboard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class QuickMemo(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val content: String,
    val updatedAt: Long = System.currentTimeMillis()
) {
    val displayTitle: String
        get() = title.ifBlank { content.lineSequence().firstOrNull()?.take(32).orEmpty() }
}

data class TextReplacement(
    val id: String = UUID.randomUUID().toString(),
    val shortcut: String,
    val replacement: String
)

/**
 * Shared local storage for the Android keyboard and its settings screen.
 * Clipboard history deliberately stays outside exported backups because it may
 * contain passwords, addresses, or other private text.
 */
object QuickContentStore {
    private const val PREFS = "quick_content"
    private const val KEY_MEMOS = "memos_v1"
    private const val KEY_REPLACEMENTS = "replacements_v1"
    private const val KEY_CLIPBOARD = "clipboard_v1"
    private const val MAX_CLIPBOARD_ITEMS = 20

    private var context: Context? = null

    fun init(context: Context) {
        this.context = context.applicationContext
    }

    fun memos(): List<QuickMemo> = decodeMemos(getString(KEY_MEMOS)).sortedByDescending { it.updatedAt }

    fun saveMemos(items: List<QuickMemo>) {
        val array = JSONArray()
        items.forEach { memo ->
            array.put(JSONObject().apply {
                put("id", memo.id)
                put("title", memo.title)
                put("content", memo.content)
                put("updatedAt", memo.updatedAt)
            })
        }
        putString(KEY_MEMOS, array.toString())
    }

    fun replacements(): List<TextReplacement> = decodeReplacements(getString(KEY_REPLACEMENTS))

    fun saveReplacements(items: List<TextReplacement>) {
        val array = JSONArray()
        items.forEach { item ->
            array.put(JSONObject().apply {
                put("id", item.id)
                put("shortcut", item.shortcut)
                put("replacement", item.replacement)
            })
        }
        putString(KEY_REPLACEMENTS, array.toString())
    }

    fun recordClipboard(text: String) {
        val normalized = text.trim()
        if (normalized.isEmpty()) return
        val updated = (listOf(normalized) + clipboardSnippets().filterNot { it == normalized })
            .take(MAX_CLIPBOARD_ITEMS)
        putString(KEY_CLIPBOARD, JSONArray(updated).toString())
    }

    fun clipboardSnippets(): List<String> {
        val raw = getString(KEY_CLIPBOARD)
        return runCatching {
            val array = JSONArray(raw)
            List(array.length()) { index -> array.optString(index).trim() }.filter { it.isNotEmpty() }
        }.getOrDefault(emptyList())
    }

    fun exportJson(): String {
        return JSONObject().apply {
            put("formatVersion", 1)
            put("createdAt", System.currentTimeMillis())
            put("memos", JSONArray(getString(KEY_MEMOS)))
            put("textReplacements", JSONArray(getString(KEY_REPLACEMENTS)))
        }.toString(2)
    }

    /** Merges an iOS-compatible backup without ever importing clipboard text. */
    fun importAndMerge(json: String): ImportResult {
        val root = JSONObject(json)
        require(root.optInt("formatVersion", -1) == 1) { "지원하지 않는 킹보드 백업 파일입니다." }

        val importedMemos = decodeMemos(root.optJSONArray("memos")?.toString().orEmpty())
        val importedReplacements = decodeReplacements(root.optJSONArray("textReplacements")?.toString().orEmpty())

        val memoMap = memos().associateBy { it.id }.toMutableMap()
        importedMemos.forEach { memoMap[it.id] = it }
        saveMemos(memoMap.values.toList())

        val replacementMap = replacements().associateBy { it.shortcut }.toMutableMap()
        importedReplacements.forEach { replacementMap[it.shortcut] = it }
        saveReplacements(replacementMap.values.toList())

        return ImportResult(importedMemos.size, importedReplacements.size)
    }

    data class ImportResult(val memos: Int, val replacements: Int)

    private fun decodeMemos(raw: String): List<QuickMemo> = runCatching {
        val array = JSONArray(raw)
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            QuickMemo(
                id = item.optString("id").ifBlank { UUID.randomUUID().toString() },
                title = item.optString("title"),
                content = item.optString("content"),
                updatedAt = item.optLong("updatedAt", System.currentTimeMillis())
            )
        }.filter { it.content.isNotBlank() }
    }.getOrDefault(emptyList())

    private fun decodeReplacements(raw: String): List<TextReplacement> = runCatching {
        val array = JSONArray(raw)
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            TextReplacement(
                id = item.optString("id").ifBlank { UUID.randomUUID().toString() },
                shortcut = item.optString("shortcut").trim(),
                replacement = item.optString("replacement")
            )
        }.filter { it.shortcut.isNotBlank() && it.replacement.isNotBlank() }
    }.getOrDefault(emptyList())

    private fun getString(key: String): String =
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.getString(key, "[]") ?: "[]"

    private fun putString(key: String, value: String) {
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.edit()
            ?.putString(key, value)
            ?.apply()
    }
}

object EmojiRecentStore {
    private const val PREFS = "quick_content"
    private const val KEY_RECENT = "recent_emojis_v1"
    private const val MAX_ITEMS = 36
    private var context: Context? = null

    fun init(context: Context) { this.context = context.applicationContext }

    fun add(emoji: String) {
        val updated = (listOf(emoji) + recent().filterNot { it == emoji }).take(MAX_ITEMS)
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()
            ?.putString(KEY_RECENT, JSONArray(updated).toString())?.apply()
    }

    fun recent(): List<String> = runCatching {
        val raw = context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.getString(KEY_RECENT, "[]") ?: "[]"
        val array = JSONArray(raw)
        List(array.length()) { array.optString(it) }.filter { it.isNotBlank() }
    }.getOrDefault(emptyList())
}
