# Discovering Hokuz tools without overlapping metadata

This guide is for callers whose runtime exposes `functions.exec` and an `ALL_TOOLS` catalog. Give the instruction below to the caller explicitly, for example in its task or client instructions. Installing the Hokuz server does not apply it automatically. Clients with another discovery interface should use that interface's normal tool selection.

## Caller instruction

> When discovering Hokuz tools through `ALL_TOOLS`, choose `hokuz_generate_image` for a new image or `hokuz_edit_image` for work with image inputs. Match the exact operation name or a namespaced name ending in `__` plus that operation. If exactly one tool matches, print its full metadata once in that same discovery call and use its description and schema to prepare the call. If none match, report native Hokuz access unavailable. If several match, print only their full names and resolve which registration to use before expanding any metadata. Do not print overlapping broad searches or both tools' full metadata together. If you need the other operation later, inspect it then. If a needed rule is referenced elsewhere or output is truncated, retrieve only the missing section in a separate output; do not repeat the entire catalog. Keep unrelated tool searches and file reads out of the same discovery output.

## Example

Choose the operation from the task. This example discovers generation; for work with input images, set `operation` to `hokuz_edit_image`.

```javascript
const operation = "hokuz_generate_image";
const matches = ALL_TOOLS.filter(t => t.name === operation || t.name.endsWith("__" + operation));
if (matches.length === 1) {
  text(matches[0]);
} else if (matches.length === 0) {
  text("Native Hokuz access is unavailable for " + operation);
} else {
  text(matches.map(t => t.name));
}
```

Read the selected entry's full description and callable schema before preparing arguments. Some runtimes include the callable declaration inside `description`; do not assume the catalog has a separate schema field. If a relevant rule refers to the other tool, retrieve that section as needed.

When several names match, use their full registration names to identify the intended server before inspecting one exact entry. If the intended registration is unclear, ask for clarification. Do not merge registrations or print all matching metadata.

This procedure limits what the caller prints. It preserves the server's model guidance and capability rules, and does not change client output limits.
