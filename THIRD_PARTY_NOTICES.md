# Third-party notices

HappyClaw is released under the MIT License (see `LICENSE`). The parts listed
below are adapted from other projects and remain under their own licenses.

## Cindy

- Source: https://github.com/makecindy/cindy, commit `7be4c57d7b`
- License: Apache License 2.0 (full text in `LICENSES/Apache-2.0.txt`)
- Notice:

  ```
  Cindy
  Copyright 2026 XD Inc.

  This product includes software developed by XD Inc.
  ```

Adapted parts, each modified for HappyClaw (every adapted file says so in its
header):

- `shared/model-providers.ts`: the vendor preset catalog, the model
  capability table (context windows and reasoning efforts), the model list
  parsing and the upstream error classification.
- `web/src/components/chat/composer/cindy/`: the chat composer's editor core
  (list nodes, punctuation and selection plugins, reference and long-paste
  chips, Markdown serialization, palette matching, the send button) and its
  tests.
