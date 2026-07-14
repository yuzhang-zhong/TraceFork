# TraceFork Human Gold Annotation Tool

Access locally or online with:

```text
/?experiment=gold
```

Purpose: let annotators create their own step-level labels for TraceFork alignment, fork, missing-counterpart, severity, and rejoin validation. The online tool does not ship with previously collected annotations.

Data is saved in browser `localStorage` under:

```text
tracefork-human-gold-subset-annotation-tool-v2
```

The UI provides JSON and CSV export. Exported rows use schema version:

```text
tracefork-human-gold-v1
```

Important protocol boundary:

- Annotators do not see TraceFork's hidden system label or score.
- The page shows task instruction, Run A / Run B local step context, observable action/target/state text, and available frames.
- Labels become usable gold data only after new independent annotation, export, and adjudication.
