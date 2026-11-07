# Translations

All interface text and alert templates live in `site/js/i18n.js`.

| Language | Status |
|---|---|
| English | Reference |
| Nigerian Pidgin | Informal; review welcome |
| Hausa | **Draft – needs native-speaker review** |
| Yorùbá | **Draft – needs native-speaker review** (tone marks included) |
| Igbo | **Draft – needs native-speaker review** |

Safety messages must be correct and unambiguous. Before promoting the site in a language, ask at least one native speaker, ideally someone who works in emergency response or extension services, to check:

1. the alert levels (`lvl`),
2. the action sentences (`act`) and `follow`,
3. the planting and season labels (`plant`, `season`).

To correct a translation, edit the matching block in `site/js/i18n.js`, remove the `draft` note for that language once it has been reviewed, and open a pull request.
