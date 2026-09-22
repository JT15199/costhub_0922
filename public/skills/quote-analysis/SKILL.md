---
name: quote-analysis
description: Analyze supplier quote files with scripts, normalize comparable rows, and report calculation assumptions and source files.
---

# Quote analysis

Use this skill when the user asks to compare supplier quotations or create a negotiation memo.

1. List the task directory and inspect each input file before deciding which columns are comparable.
2. Keep source file names and sheet names with every normalized row.
3. Prefer analyze_spreadsheet: inspect a small sample, then supply verified column letters, detail row range and pricing basis to calculate. The tool processes all rows, writes the evidence file and returns a compact summary. Do not paginate through the full sheet or call calc per row for totals. It needs no terminal permission. Formula cells, unknown quantities and ambiguous prices remain unresolved; never use cached formula values as verified amounts. Only use a script when the table needs processing this tool cannot express, and only with existing terminal authorization.
4. If a script fails, read stderr, fix the script, and run it again.
5. Generate an openable CSV or Excel-compatible file and a short Markdown memo in the task directory.
6. Report the tax rate, currency, exchange-rate assumption, and excluded rows.
