"""Small, targeted real test of the AI Museum Guide: only the cases fixed in the Step 3 finalisation.

Run it from the ai_service folder:   python smoke_test_guide_targeted.py

  C2  Arabic follow-up "وفين هي؟" after the Hanging Obelisk (must use the location in the notes)
  C3  "Who built it?" (our notes say King Ramesses II raised it, nothing about builders: answer only that, or refuse)
  C4  English follow-up "Where is it?"
  F6/F7  broad questions about the Tutankhamun Galleries (English / Arabic): several cited artefacts
  T1/T2  Arabic "where do I buy official tickets" (the right note is 2nd in the RAG ranking; the guide must still use it)
  U1-U4  the restaurant / drone / Great Pyramid / Arabic restaurant refusals still hold (the judge instructions changed)
  plus: does POST /guide/chat accept a real login?

For the login check you can paste a CURRENT token at a HIDDEN prompt (nothing is shown, printed or saved), or put it in
.env as SMOKE_TEST_ACCESS_TOKEN. Press Enter to skip. The report has a trace line under every reply: which notes were
searched, which were reused from earlier turns, what the judge decided, and which notes it approved.
Read-only. Cost: a few cents. Report: smoke_test_guide_targeted_report.md
"""

import sys

from app.config import get_settings
from app.services import build_services
from smoke_test_guide import HERE, read_token, run

TARGETED = ("C2", "C3", "C4", "F6", "F7", "T1", "T2", "U1", "U2", "U3", "U4")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    settings = get_settings()
    missing = [name for name, value in (
        ("SUPABASE_URL", settings.supabase_url), ("SUPABASE_SECRET_KEY", settings.supabase_secret_key),
        ("SUPABASE_PUBLISHABLE_KEY", settings.supabase_publishable_key), ("OPENAI_API_KEY", settings.openai_api_key),
        ("OPENAI_CHAT_MODEL", settings.openai_chat_model)) if not value]
    if missing:
        print("Cannot run: these values are empty in ai_service\\.env: " + ", ".join(missing))
        return 2
    return run(build_services(settings), read_token(), HERE / "smoke_test_guide_targeted_report.md", only=TARGETED)


if __name__ == "__main__":
    sys.exit(main())