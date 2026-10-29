# Contributing / 開発・不具合報告

Issues and pull requests in English or Japanese are welcome.
英語・日本語のIssue、Pull Requestを受け付けています。

## Report a problem / 不具合報告

Use [GitHub Issues](https://github.com/ukr8b3g-cmyk/Forge-Neo-Generation-Queue/issues) and include:

- Forge Neo and extension revisions, Gradio version, OS, and browser.
- Reproduction steps, expected result, and actual result.
- Queue ON/OFF, running/waiting counts, and relevant extensions.
- Relevant error text or screenshots with personal information removed.

本体・拡張のリビジョン、Gradio・OS・ブラウザー、再現手順、期待する動作と実際の動作、キュー状態、併用拡張を記載してください。ログや画像から個人情報を除いてください。

## Changes and checks / 変更と確認

Keep changes focused and preserve the native generation behavior when the queue is OFF. Update both READMEs when user-facing behavior changes.
変更は目的に絞り、キューOFF時の標準動作を維持してください。利用方法が変わる場合は日英READMEも更新します。

Run the portable tests from the repository root:

```sh
python -m unittest discover -s tests -p 'test_queue.py' -v
```

For JavaScript edits, check syntax with `node --check javascript/generation_queue.js` and verify the affected UI behavior. State which checks you ran; distinguish simulated tests from actual Forge/GPU generation. See [TESTING.md](TESTING.md).

JavaScript変更時は上記構文検査と影響する画面操作を確認し、PRに検証内容を記載してください。模擬テストと実Forge・GPU生成の確認は区別します。

Contributions are made under this repository's [MIT License](LICENSE).
提供する変更には、このリポジトリの[MITライセンス](LICENSE)を適用します。
