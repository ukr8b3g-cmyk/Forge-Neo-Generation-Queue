"""WebUI locale only; unspecified locales use English."""
import re

MESSAGES = {
    "Enable generation queue (txt2img)": "生成キューを有効にする（txt2img）",
    "Generation Queue": "生成キュー",
    "Queue one job per Generate click. Add to Quicksettings manually.": "Generateを押すたびに予約。Quicksettingsへの登録は手動です。",
    "Could not connect the generation queue. Check the Forge startup log.": "生成キューを接続できませんでした。Forgeの起動ログを確認してください。",
    "Invalid client ID. Reload the page.": "操作元のIDが無効です。ページを再読み込みしてください。",
    "Cannot read shared settings. Resume after settings have finished saving.": "共通設定を読み取れません。設定の保存完了後に再開してください。",
    "Model or shared settings have changed since this job was queued. Restore them and resume, or cancel the job with ×.": "モデル・共通設定が予約時から変わっています。元に戻して再開するか、予約を×で取り消してください。",
    "Could not retrieve the generation result.": "生成結果を取得できませんでした。",
    "Wait for the accepted queue jobs to finish.": "登録済みの生成キューが終わるまでお待ちください。",
    "Generation queue is OFF.": "生成キューはOFFです。",
    "Invalid job ID.": "予約IDが無効です。",
    "The queue is paused. Resume it or cancel pending jobs.": "キューが停止中です。再開または待機予約の取り消しを行ってください。",
    "Job not found.": "予約が見つかりません。",
    "The UI is reloading. Reload the page.": "UI再読み込み中です。ページを再読み込みしてください。",
    "Duplicate job ID.": "予約IDが重複しています。",
    "Too many clients have pending results. Reconnect those tabs or wait 30 minutes.": "未受信結果を持つ操作元が上限に達しました。該当タブを再接続するか、30分お待ちください。",
    "Resume the queue from the client that paused it.": "停止したキューの操作元で再開してください。",
    "Another client's queue is paused.": "別の操作元のキューが停止中です。",
    "Generation failed. Check the settings and resume.": "生成に失敗しました。条件を確認し、再開してください。"
}


def is_japanese(locale):
    return bool(re.match(r"^(?:ja(?:$|[-_ (])|japanese(?:$|[-_ (])|日本語)", str(locale or "").strip(), re.I))


def translate(text, locale=None):
    if locale is None:
        from modules import shared
        locale = shared.opts.data.get("localization", "")
    if not is_japanese(locale):
        return text
    limit = re.fullmatch(r"Generation queue limit is (\d+) jobs\.", text)
    return f"生成キューの上限は{limit[1]}件です。" if limit else MESSAGES.get(text, text)
