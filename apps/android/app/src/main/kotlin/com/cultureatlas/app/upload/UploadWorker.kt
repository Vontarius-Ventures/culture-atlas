package com.cultureatlas.app.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.cultureatlas.app.CultureAtlasApplication
import com.cultureatlas.capture.core.contract.PartInstruction
import com.cultureatlas.capture.core.store.DraftRecord
import com.cultureatlas.capture.core.upload.PartTransfer
import com.cultureatlas.capture.core.upload.UploadEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Persistent background upload for one draft (WorkManager survives process
 * death and reboots). Wi-Fi only (unmetered) unless the person chose mobile
 * data for that item. Each run is one `UploadEngine` pass; progress lives in
 * the draft record, so a rerun resumes from server receipts.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as CultureAtlasApplication
        val draftId = inputData.getString(KEY_DRAFT) ?: return Result.failure()
        val owner = inputData.getString(KEY_OWNER) ?: return Result.failure()
        val signedIn = app.graph.sessions.currentAccountId
        // A different signed-in account never moves these bytes.
        if (signedIn?.lowercase() != owner.lowercase()) return Result.success()
        return when (val result = app.graph.uploadEngine.run(draftId, signedIn)) {
            UploadEngine.Result.Done, UploadEngine.Result.Locked -> Result.success()
            UploadEngine.Result.Waiting -> Result.success()
            is UploadEngine.Result.Retry -> {
                if (result.afterMillis <= 0) {
                    enqueue(applicationContext, draftId, owner, cellular = inputData.getBoolean(KEY_CELLULAR, false))
                    Result.success()
                } else {
                    Result.retry()
                }
            }
        }.also { app.graph.notifyDraftsChanged() }
    }

    companion object {
        private const val KEY_DRAFT = "draft_id"
        private const val KEY_OWNER = "owner"
        private const val KEY_CELLULAR = "cellular"

        fun enqueue(context: Context, draft: DraftRecord) =
            enqueue(context, draft.id, draft.ownerAccountId, draft.allowCellular)

        fun enqueue(context: Context, draftId: String, owner: String, cellular: Boolean) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf(KEY_DRAFT to draftId, KEY_OWNER to owner, KEY_CELLULAR to cellular))
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(if (cellular) NetworkType.CONNECTED else NetworkType.UNMETERED)
                        .setRequiresStorageNotLow(false)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .addTag(tagFor(owner))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("upload-$draftId", ExistingWorkPolicy.REPLACE, request)
        }

        fun tagFor(owner: String) = "uploads-${owner.lowercase()}"

        /** Sign-out: stop every transfer belonging to that account. */
        fun cancelAll(context: Context, owner: String) {
            WorkManager.getInstance(context).cancelAllWorkByTag(tagFor(owner))
        }
    }
}

/** PUT to the server-signed part URL; the ETag is the receipt. No bearer token is sent. */
class OkHttpPartTransfer(
    private val client: OkHttpClient = OkHttpClient.Builder().writeTimeout(5, TimeUnit.MINUTES).build(),
) : PartTransfer {
    override suspend fun put(instruction: PartInstruction, file: File): String = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(instruction.url)
            .method(instruction.method, file.asRequestBody(null))
            .apply { instruction.headers.forEach { (name, value) -> header(name, value) } }
            .build()
        client.newCall(request).execute().use { response ->
            if (response.code == 403) throw PartTransfer.ExpiredInstruction()
            if (!response.isSuccessful) throw IOException("part upload failed: ${response.code}")
            response.header("ETag")?.takeIf { it.isNotEmpty() } ?: throw IOException("missing ETag")
        }
    }
}
