# Changelog

## 0.1.0

First release.

- Hold Space to dictate: live words appear in the prompt in gray, and the final transcript replaces them on release.
- Questions get their "?" (and "¿" in Spanish) even when read flat.
- Fully local recognition: Nemotron 3.5 Streaming for live words, Parakeet Ultra for the final text.
- Instant release, read from the Space key while dictating. Falls back to the kitty keyboard protocol or auto-repeat detection.
- Keys pressed right after releasing, such as Enter, act on the finished prompt.
- Dictation only starts when the prompt editor has focus.
