# PR-target certification fixture

This file exists solely to give a certification PR a tiny, harmless diff
against `cert/pr-target-base` (787a4070336d9839590d437ce95ec8a898519d11).

It verifies the ReviewLoop PR-target production path end to end:
repository identity, exact base/head SHA binding, Gate verdict on the
reviewed HEAD without snapshot mutation, and a real Reviewer call.

No application code is touched by this fixture.
