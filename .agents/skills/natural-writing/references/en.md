# English AI-Style Patterns and Revisions

Treat the patterns below as review signals rather than automatic deletions. When revising, keep all numbers, names, conditions, and claims intact.

## Common AI-Style Signals

| Pattern | Flagged Example | Revised Example |
|---|---|---|
| Overused verb (`delve`) | "Let us delve into the cache settings." | "This section explains the cache settings." |
| Throat-clearing (`It's important to note that`) | "It's important to note that the port must be open." | "The port must be open before starting the worker." |
| Formulaic summary (`In conclusion,`) | "In conclusion, the new index cuts lookup time by half." | "The new index cuts lookup time by half." |
| Rhetorical contrast (`not just X, but Y`) | "This is not just a script, but a complete workflow." | "This script checks Markdown files and prints line numbers." |
| Cliche opening (`In today's fast-paced world`) | "In today's fast-paced world, teams ship daily." | "Teams that ship daily need fast local checks." |
| Promotional hype (`game-changer`) | "Local caching is a game-changer for CI speed." | "Local caching reduces CI run time from 6 minutes to 90 seconds." |
| Vague modifier (`seamlessly`) | "The module integrates seamlessly with existing runners." | "The module runs in existing Node test runners without extra setup." |
| Corporate verb (`leverage`) | "The parser leverages regular expressions to match tokens." | "The parser uses regular expressions to match tokens." |
| Inflated praise (`a testament to`) | "The low failure rate is a testament to careful testing." | "Careful testing kept the failure rate below 0.2%." |
| Vague metaphor (`navigate the complexities`) | "This guide helps you navigate the complexities of encoding." | "This guide explains how to handle UTF-8 byte offsets." |
| Unprompted disclaimer (`This is not intended to`) | "This is not intended to replace human editors." | "This checker highlights candidate lines before human review." |
| Chained em dashes (three or more in a paragraph) | "The runner—built on Node—reads files—even nested ones—in one pass." | "The runner is built on Node and reads nested files in one pass." |
| Repeated transitions (`Furthermore,` / `Moreover,`) | "Furthermore, it runs offline. Moreover, it exits with code 1 on warnings." | "It runs offline and exits with code 1 when `--strict` is set." |

## Revision Notes

- **External writing**: Prefer direct, affirmative sentences. State what the software or policy does rather than what it is not trying to do.
- **Technical precision**: Replace vague adjectives (`seamless`, `robust`, `cutting-edge`) with the specific behavior, constraint, or measurement.
