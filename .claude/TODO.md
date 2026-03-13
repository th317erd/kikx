# TODO: Markdown-to-HTML Conversion for User Messages

## Summary
Server-side markdown→HTML conversion for user messages. Opt-in via `convertMarkdown: true` flag on API call. Client defaults to `true`. Not for agents — they output HTML natively. Plugin interface exposed via context.

**Library:** `marked` (simple, lightweight)
**Storage:** Replace — store HTML, not both text and HTML
**Sanitization:** Full sanitization with whitelisted safe elements (existing ContentSanitizer)

---

## Steps

- [x] **Step 1: Install `marked` dependency**
- [x] **Step 2: Create `src/core/lib/markdown-converter.mjs`**
- [x] **Step 3: Register MarkdownConverter on context**
- [x] **Step 4: Thread `convertMarkdown` through the server**
- [x] **Step 5: Update `buildMessages()` in message-history.mjs**
- [x] **Step 6: Client changes**
- [x] **Step 7: Write tests**
- [x] **Step 8: Run full test suite** — 2398 tests, 0 failures
