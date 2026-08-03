# Naia gateway contract

Default base URL: `https://api.nextain.io/v1`

| Purpose | Method and path | Key required |
|---|---|---|
| Model catalog | `GET /models` | No |
| Charged model prices | `GET /pricing` | No |
| Validate key and read balance | `GET /profile/balance` | Yes |
| Text generation | `POST /chat/completions` | Yes |

Authentication accepts `Authorization: Bearer <NAIA_KEY>`. `NAIA_KEY` is the client-side environment-variable name, not part of the HTTP protocol. Catalog entries expose `model_key`, `capabilities`, `supports_tools`, `upstream_provider`, `lifecycle`, `protocol`, and `operational_status`. Pricing entries expose input/output prices per one million tokens or an hourly rate.

Catalog model keys are the values clients send to chat completions. A pricing row can be provider-qualified, such as `azure:deepseek-v4-flash`; the client matches a unique `:<catalog-model-key>` suffix when no exact pricing key exists.

The balance endpoint currently returns a legacy `balance` value in micro-dollars. The client converts it to Naia credits using 1,000 credits per USD. Do not expose the user identifier in routine CLI output.

The OpenAI-compatible response is expected to contain `choices[0].message.content`, `model`, and optional `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens`.
