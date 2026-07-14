# TraceFork Analyst Walkthrough Annotation Tool

Access locally or online with:

```text
/?experiment=pilot
```

Purpose: let analysts create their own walkthrough records comparing `raw_logs` and `tracefork` conditions. The online tool does not ship with previously collected pilot records.

Data is saved in browser `localStorage` under:

```text
tracefork-analyst-pilot-annotation-tool-v2
```

The UI provides JSON and CSV export. Exported rows use schema version:

```text
tracefork-analyst-pilot-v1
```

Collected fields include participant id, condition, elapsed time, first fork step, rejoin judgment, main cause, confidence, usefulness, mental effort, and free-text feedback.

Important protocol boundary:

- This is an annotation frontend, not participant evidence until new participants complete and export it.
- Use counterbalanced task ordering when possible: alternate `TraceFork` and `Raw logs` conditions across participants.
