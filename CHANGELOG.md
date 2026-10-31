# Changelog / 変更履歴

## 2026-10-31 — Idle connection recovery / 放置後の通信復旧

- Handle both successful and failed Gradio status requests so failed requests cannot leave the client permanently busy. Validate reply IDs, retry completed failures with 1.5–15 second backoff, and preserve one in-flight status request.
- Separate connection warnings from generation admission errors so a delayed status reply does not disable manual Generate. Never automatically replay generation requests.
- Verified with 25 Node tests, 24 Python checks and an installed-Gradio CPU/browser failure-and-delay regression. Real GPU and PC sleep/resume remain untested.

日本語：通信失敗後に状態確認が止まりGenerateまで拒否される問題を修正。成功・失敗の終了通知と応答IDを確認し、失敗した状態確認だけを1.5～15秒の間隔で再試行する。通信エラーを生成受付エラーから分離し、生成要求の自動再送は行わない。Node25件・Python24件・実Gradioの隔離CPU／ブラウザー試験で確認。実GPUと実際のPCスリープ復帰は未検証。

## 2026-10-29 — Deferred early status refresh / 送信後の再確認保留

- Retain one send-triggered early status check when another request is in flight, then run it after processing the response. Coalesce repeated early checks without overlapping requests or speeding up regular 750ms polling. Preserve result acknowledgement after OFF and timeout behavior without generation retries.

日本語：送信後の早期状態確認が通信中に重なった場合、要求を1件だけ保持して応答処理後に実行する。連続要求をまとめ、通常の750ms間隔と重複通信防止を維持。OFF後の最終受信確認とタイムアウト時の自動再送防止も保持する。

## 2026-10-29 — Heading progress / 見出しの進捗表示

- Fill the compact Generating / Remaining heading from left to right with the current job's progress, including when details are closed. Reuse the existing native progress callback, preserve 22px height, text and disclosure controls, reset per job, and hide the fill while paused or idle.

日本語：Generating／Remainingの見出しにも現在生成中の1件の進捗を青い背景で表示。詳細を閉じた状態でも確認でき、高さ22px・文字・開閉操作を維持。既存の進捗通知を共有し、ジョブ切替でリセット、停止中・待機時は進捗色を表示しない。

## 2026-10-29 — Faster startup and clearer queue controls / 起動時受付・キュー操作の改善

- Submit through the existing Generate event as soon as WebUI settings are known, without waiting for the initial queue-status reply. Start the single status handler from Gradio's page-load event, preserve one submission per click, and retain post-submission polling and final-result acknowledgement after OFF. Report stalled status requests without overlapping requests or automatic replay.
- Keep existing txt2img infotext at full opacity during queue status checks, including draining after OFF and final-result acknowledgement. Restore native pending styling when the queue is OFF and idle; other tabs are unaffected.
- Give Resume a pale blue background, dark text, and a visible keyboard-focus outline so the action is easier to find while paused.
- Style the queue's expandable status heading as a compact dark-blue control, 22px high, with white text, a blue border, and a lighter hover state. Preserve the native disclosure arrow and keyboard opening; truncate text inside narrow controls.
- Explain when Resume appears, how to address the pause and continue retained jobs, how it differs from Generate and normal cancellation, and why failed jobs are not retried, in both READMEs.

日本語：キュー状態確認中に画像下の文章が薄くなってちらつく表示を修正。OFF後の受付済み処理・最終受信確認中も読みやすさを維持し、OFF・待機時は標準表示へ戻す。他タブは変更しない。

WebUI設定の読込後は、初回のキュー状態応答を待たずに既存Generateから送信するよう変更。Gradioのページ読込イベントから同じ状態取得処理を開始し、1クリック1送信を維持。OFF後も送信後の状態確認と最終結果の受信確認を行う。状態確認が滞った場合は重複通信・自動再送をせず案内する。

再開ボタンは淡い水色背景・濃い文字にし、キーボードフォーカスの枠も表示して見つけやすくした。

生成中・残り件数の開閉見出しを高さ22pxの濃い青のボタン風に変更。白文字・青い枠・明るいホバー色を付け、三角の開閉表示とキーボード操作を維持。狭い幅では文字を枠内で省略する。

日英READMEへResumeの表示条件・原因の確認・同じタブからの再開手順を追記。Generate・通常の取消との違いと、失敗したジョブを自動でやり直さないことも明記。

## 2026-10-29 — Running-row progress / 生成中行の進捗表示

- Extend a blue progress fill from left to right behind the running row, using Forge's existing progress callback without additional polling. Preserve readable text and row cancellation controls, reset per job, and ignore late replies from earlier jobs.
- Add client and isolated-browser progress regressions and explain the approximate progress in both READMEs.

日本語：生成中の行に、進捗に合わせて左から右へ伸びる青い背景を追加。既存の進捗通知を再利用し、ジョブ切替でリセット、古い通知は無視。文字・取消操作・行の高さを維持し、日英説明と回帰テストを追加。

## 2026-10-29 — UI feedback and atomic completion / 表示・完了処理の改善

- Show immediate Sending feedback and a blue button before generation, with one early status check. Preserve startup clicks while waiting up to 10 seconds for the initial connection; report timeouts without retrying automatically.
- Hide the count and expanded details when no jobs remain, preserving errors and final-result acknowledgement. New jobs reappear with details collapsed.
- Publish terminal job state, result delivery, input cleanup, and client-slot accounting in one queue lock operation. Add deterministic completion-boundary regressions for idle polling and the 32-client limit.
- Make queue details fully opaque so underlying controls no longer show through.
- Use a navy running row with soft white text and a blue left border, distinct from the green Generate button.
- Turn enabled row × buttons red with white text on hover. Keep the startup Connecting/Sending gap below Generate at 2px.
- Explain the row × buttons for pending cancellation and running interruption in both READMEs. Refresh the idle/generating examples and replace the expanded view with the user-provided five-job screenshot showing the red hover and interrupt tooltip.

日本語：詳細背景を不透明度100％へ変更。生成中行は濃いネイビー＋白文字＋青ライン、×は赤ホバー。起動時もGenerate下の間隔を2pxに統一。全完了時は件数と空詳細を非表示にし、送信直後の反応と起動時の接続待ちを改善。取消・中断を日英で説明し、待機／生成中の例とユーザー提供の赤ホバー詳細画像を掲載。

完了状態と結果登録の間の競合も修正。完了・中断の最終結果通知と32操作元の枠維持を、スレッドの実行順を制御する回帰テストで確認。

## 2026-10-29 — Queue reliability fixes / キュー制御修正

- Release a global pause when its owner has no unfinished work, retaining settings guards for subsequent jobs and visible failure details.
- Generate secure client/job IDs with `crypto.getRandomValues` so HTTP LAN origins do not depend on `crypto.randomUUID`.
- Retain each client's latest result until acknowledged, with 30-minute expiry for idle clients and reserved delivery slots for up to 32 clients. Reject additional clients instead of silently evicting unreceived results.
- Add seven portable queue regressions and six Node standard-library client checks.

日本語：停止所有者に未完了ジョブが残らない場合の停止解除、HTTP接続時のID生成を修正。未受信結果は受信確認・期限で管理し、32操作元の結果通知枠を確保。キュー7件とクライアント6件の回帰テストを追加。

## 0.1.0 — 2026-10-29

- Initial public version: txt2img FIFO queue through the existing Generate button, up to 32 active jobs.
- Optional Settings / Quicksettings toggle, individual cancellation and interruption, pause/resume, and English/Japanese UI.
- Compact remaining count includes the running job; details show only unfinished jobs. Both Generate and the running row turn green.
- English and Japanese guides with screenshots, Install from URL, Git installation, and update instructions.
- MIT license, testing notes, and contribution guidance.

日本語：初回公開版。既存Generateによる最大32件の順次生成、設定ON/OFF、個別取消・中断・再開、日英表示に対応。件数は生成中を含む残り件数に統一し、完了履歴を除外。Generateと生成中の行を緑色表示。日英README・画像・導入更新手順・MITライセンスを整備。

This records the initial version and its same-day refinements; it does not imply a GitHub Release or tag was created.
初回版と同日の改善をまとめた記録です。GitHub Release・タグの作成を意味しません。
