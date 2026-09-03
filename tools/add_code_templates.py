#!/usr/bin/env python3
"""Add the code being completed to the case-study drop-down questions.

The PDF renders these questions as "Answer Area" pictures: a Transact-SQL or
YAML listing with a drop-down box drawn at each position to fill in. Only the
options survived the text extraction, so the app showed the choices with no code
around them and the question could not be answered on its own terms.

Each template below is transcribed from the answer-area picture, with ``[[n]]``
marking where box n belongs, so the app can render the drop targets in place.

Question 139 needed a different fix: it is a single-answer question whose blanks
had been copied from question 58 during extraction.
"""

import io
import json
import re
import sys

PATIENT_LISTS = """CREATE PROCEDURE dbo.GetActivePatients
AS
BEGIN
    SET NOCOUNT ON;
    SELECT p.Name
    FROM dbo.Patients AS p
    [[1]] (
        SELECT PatientId
        FROM dbo.Procedures AS pr
        [[2]]
        AND pr.TransactionDate >= DATEADD(DAY, -30, SYSUTCDATETIME())
    );
END;"""

VALIDATE_WORKFLOW = """name: Validate SQL Project
on:
  [[1]]:
    branches: [ "main" ]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Step 1
        run: dotnet [[2]]"""

TEMPLATES = {
    1: ("sql", """SELECT
    f.FeedbackId,
    f.VehicleId,
    [[1]],
    EDIT_DISTANCE_SIMILARITY(
        JSON_VALUE(f.FeedbackJson, '$.text'),
        @KnownIssueDescription
    ) AS SimilarityScore
FROM
    dbo.CustomerFeedback f
WHERE
    [[2]]
ORDER BY
    [[3]] DESC;"""),
    16: ("sql", PATIENT_LISTS),
    135: ("sql", PATIENT_LISTS),
    29: ("sql", """CREATE TRIGGER dbo.trgMaintenanceEvents_UpdateTimestamp
ON dbo.MaintenanceEvents
AFTER UPDATE
AS
BEGIN
    UPDATE m
    SET LastModifiedUtc = SYSUTCDATETIME()
    FROM dbo.MaintenanceEvents m
    INNER JOIN inserted i
    ON [[1]]
    WHERE [[2]]
END;
GO"""),
    58: ("sql", """CREATE [[1]] dbo.CustomerTransactionsBetweenDates
(
    @CustomerId INT,
    @StartDate DATETIME2,
    @EndDate   DATETIME2
)
RETURNS TABLE
AS
RETURN
(
    SELECT
        t.TransactionId,
        t.CustomerId,
        t.TransactionDate,
        t.Amount,
        SUM(t.Amount) OVER (
            [[2]]
            [[3]]
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS RunningTotal
    FROM dbo.Transactions AS t
    WHERE t.CustomerId = @CustomerId
      AND t.TransactionDate >= @StartDate
      AND t.TransactionDate <= @EndDate
);"""),
    60: ("yaml", VALIDATE_WORKFLOW),
    134: ("yaml", VALIDATE_WORKFLOW),
}

# The box labels are what the review screen lists, so they name the line the box
# sits on rather than "First dropdown".
LABELS = {
    1: ["SELECT list, after f.VehicleId",
        "WHERE",
        "ORDER BY"],
    16: ["After FROM dbo.Patients AS p",
         "After FROM dbo.Procedures AS pr"],
    135: ["After FROM dbo.Patients AS p",
          "After FROM dbo.Procedures AS pr"],
    29: ["INNER JOIN inserted i ON",
         "WHERE"],
    58: ["CREATE ... dbo.CustomerTransactionsBetweenDates",
         "SUM(t.Amount) OVER (",
         "After the PARTITION BY clause"],
    60: ["on:", "run: dotnet"],
    134: ["on:", "run: dotnet"],
}

Q139_CHOICES = [
    ("A", "sp_OACreate", False),
    ("B", "sp_addendpoint", False),
    ("C", "xp_cmdshell", False),
    ("D", "sp_invoke_external_rest_endpoint", True),
]

Q139_STEM = ("You need to use the UsefulPrompts table as defined in the AI requirements.\n"
             "Which stored procedure should you use?")

Q139_EXPLANATION = (
    "sp_invoke_external_rest_endpoint is the stored procedure that calls external REST "
    "endpoints directly from Azure SQL Database, which is the supported way to send the "
    "prompts stored in UsefulPrompts to an Azure OpenAI endpoint.\n"
    "sp_OACreate is incorrect because it creates OLE Automation objects, which are not "
    "supported in Azure SQL Database. sp_addendpoint is incorrect because it is not a valid "
    "stored procedure for invoking external REST APIs. xp_cmdshell is incorrect because it "
    "runs operating-system commands, is disabled by default for security reasons, and cannot "
    "call a REST endpoint."
)


def main(path):
    with io.open(path, encoding="utf-8") as fh:
        exam = json.load(fh)
    by_id = {q["id"]: q for q in exam["questions"]}
    changed = []

    for qid, (lang, template) in TEMPLATES.items():
        q = by_id[qid]
        blanks = q.get("blanks") or []
        markers = sorted(int(n) for n in set(re.findall(r"\[\[(\d+)\]\]", template)))
        if markers != list(range(1, len(blanks) + 1)):
            raise SystemExit(f"Q{qid}: {markers} boxes in the template, {len(blanks)} in the data")
        q["codeLang"] = lang
        q["codeTemplate"] = template
        for j, label in enumerate(LABELS[qid]):
            blanks[j]["statement"] = label
        changed.append(f"Q{qid}: {len(blanks)}-box {lang} template")

    q = by_id[139]
    q["type"] = "single"
    q["stem"] = q["stem"].replace(q["groupStem"], Q139_STEM)
    q["groupStem"] = Q139_STEM
    q["choices"] = [{"key": k, "text": t, "correct": c} for k, t, c in Q139_CHOICES]
    q["explanation"] = Q139_EXPLANATION
    q.pop("blanks", None)
    changed.append("Q139: dropdown -> single (blanks had been copied from Q58)")

    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(exam, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"Updated {path}")
    for line in changed:
        print("  " + line)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/exams/dp-800.json")
