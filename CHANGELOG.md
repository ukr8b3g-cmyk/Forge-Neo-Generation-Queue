# Changelog / 変更履歴

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
