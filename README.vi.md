[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | [Português](README.pt.md) | [Bahasa Indonesia](README.id.md) | **Tiếng Việt**

# Naia ADK

**Khung sườn không gian làm việc được sắp xếp sẵn để các tác tử coding AI làm việc.**

Khi bạn dùng các công cụ coding AI như Claude Code hay Codex, mỗi công cụ lại cất
tệp quy tắc ở một nơi khác nhau, và những câu hỏi như “tài liệu này có được công
bố không?” hay “skill đặt ở đâu?” đều được trả lời tùy hứng. Naia ADK dựng sẵn
bộ khung đó từ trước. Giống như chuẩn bị môi trường phát triển trên laptop mới,
nó trao cho tác tử AI một chiếc bàn gọn gàng để bắt đầu. Kèm theo là một bảng
điều khiển để nhìn trạng thái không gian làm việc trong nháy mắt.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Chạy được trong 5 phút

Bạn cần **Node 22+** và **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Mở `http://localhost:3142` trong trình duyệt để xem bảng điều khiển. Ba thứ hiện
ra ngay:

- **Workspace** — dự án và submodule, cây tệp, và mức công bố của từng mục.
- **Skills catalog** — danh sách skill đã đăng ký trong không gian làm việc này,
  và nội dung của chúng.
- **Settings / monitoring** — cấu hình máy chủ, trạng thái máy khách, thư mục dữ
  liệu.

Bảng điều khiển chỉ chuyển tiếp các yêu cầu `/api/portal` của khung nhìn tài
liệu tới máy chủ API ở cổng 3141. Để chỉ chạy một trong hai, dùng
`pnpm dev:server` (→ 3141) hoặc `pnpm dev:dashboard` (→ 3142). Các kịch bản khởi
động `./start.sh` (Linux/macOS) và `start.bat` (Windows) đều chạy `pnpm dev`.
CLI máy chủ chấp nhận `--port`, `--host` và `--root`; ví dụ, trỏ sang không gian
làm việc khác bằng `pnpm serve -- --root /path/to/workspace`.

## Bên trong có gì

### Khung sườn không gian làm việc

Nó trao cho tác tử AI một bộ thư mục với vị trí cố định cho mọi thứ, để tác tử có
thể bắt đầu làm việc ngay. Ngữ cảnh dành cho AI nằm ở `.agents/` (tiếng Anh,
JSON/YAML). Hướng dẫn cho người đọc nằm ở `.users/context/` (tiếng Hàn) và
`.users/context/en/` (tiếng Anh). Tấm gương này là một phần, không phải bản sao
đầy đủ — nó chỉ giữ những tài liệu con người cần đọc (ví dụ, skill có dạng chính
tắc dưới `.agents/skills/`, và chỉ một số được phản chiếu sang `.users/skills/`).
Skill, dữ liệu và dự án đều có vị trí chỉ định, nên không gian làm việc trông
giống nhau dù công cụ nào mở nó.

### Bảng điều khiển và API

Bảng Next.js quản lý không gian làm việc bằng hình ảnh, được chống lưng bởi máy
chủ API Fastify. Các tab **Docs** (`/docs`) và **Work** ở điều hướng trên cùng
hiển thị tài liệu chung của công ty và bảng cộng tác ở một chỗ, và lệnh
`pnpm adk:setup -- --company <repo-url>` dựng kho tài liệu công ty và kho dự án
trong một bước. Chi tiết cài đặt và sử dụng xem
[hướng dẫn onboarding](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Xem [hướng dẫn viết tài liệu phát triển](docs/guides/dev-docs-writing.en.md)
để ghi lại kiến trúc, hợp đồng và bằng chứng triển khai.
API phơi bày siêu dữ liệu không gian làm việc (`/api/workspace`), danh mục skill
(`/api/skills`), cổng tài liệu công ty (`/api/portal`), và một WebSocket truyền
sự kiện thay đổi tệp (`/api/ws`). Nhờ API này, các chương trình khác ngoài bảng
điều khiển cũng với tới không gian làm việc.

### Hệ thống skill

Các tác vụ lặp lại được gói thành skill tái dùng. Mỗi skill được định nghĩa bởi
đúng một `SKILL.md`, và máy chủ API quét `skills/` để dựng danh mục. Nếu chỉ một
skill vi phạm định dạng, cả danh mục báo lỗi (đóng-chặt): thay vì lặng lẽ bỏ
skill hỏng và phục vụ phần còn lại, người vận hành bị buộc phải sửa ngay tại
chỗ. Đó là lựa chọn có chủ ý để không vô tình phát hành danh mục thiếu.

### Hôm nay cây skill có gì

Các skill chia thành bốn nhóm. Để một phiên không phải đọc lại từng `SKILL.md`
mới biết có gì, `.agents/context/skills-index.yaml` giữ một dòng mỗi skill nói
rõ nó làm gì và khi nào dùng. Danh sách dưới là mục lục của chỉ mục đó.

**Tài liệu và việc hướng ra ngoài** — những thứ con người sẽ đọc.
`doc-coauthoring` (đặc tả và tài liệu thiết kế), `proposal-writing`, `read-doc`,
`translate-doc`, `press-release`, `weekly-report`, `document-generation` (PDF
mang thương hiệu và chữ ký số), `copyright-reg` (đăng ký bản quyền),
`patent-draft` và `patent-pipeline` (bằng sáng chế), `youtube-upload` (video và
phụ đề).

**Vận hành không gian làm việc** — những bàn tay chạm vào chính repo.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (đồng bộ upstream), `manage-skills`, và
`secret-vault` cho két bí mật mã hóa.

**Cổng kiểm chứng** — những nơi đòi bằng chứng thay vì lời khẳng định.
`verify-implementation`, `verify-contract-conformance`, `verify-request-contract`,
`verify-product-preservation`, `verify-benchmark-contract`, `verify-review-gate`,
`verify-build` (có build thật không), `verify-conflict-markers` (còn sót dấu
xung đột không), `verify-i18n` và `verify-hardcoded-strings` (chuỗi có đúng chỗ
không), `webapp-testing`, và `review-pass` cho phản biện đối kháng.

**Vận hành và thử nghiệm** — việc vươn ra ngoài hoặc chạm tới mô hình.
`manage-discord-sessions` cho cổng Discord, `channel-management`,
`service-management` (uptime, chi phí, sự cố), `web-monitoring`, `email`, `sms`,
`upstream-pr-review` (một cửa lọc trước mọi thứ gửi tới maintainer OSS),
`payroll`, và `finetune-persona` để huấn luyện LoRA nhân vật.

Bắt đầu skill mới từ `.agents/skills/SKILL_TEMPLATE.md`, và thêm dòng của nó vào
chỉ mục khi đã có. Khi chỉ mục lệch khỏi cây, phiên tiếp theo dựng lại skill mà
nó đã từng có.

### Quy tắc và quản trị tối thiểu

Ngay cả không gian làm việc dùng một mình cũng cần vài quy tắc tối thiểu một khi
AI và tự động hóa chạm vào. Naia ADK tách `read`, `write`, `execute` và `publish`
thành những mối quan tâm riêng, và gắn cho mỗi tài liệu một mức công bố. Hành
động khó đảo ngược — đổi production, xử lý bí mật, phát ngôn công khai — được
tách khỏi sửa đổi cục bộ thường ngày và đi qua cổng phê duyệt.

Công bố có bốn mức. `public` an toàn để đưa nguyên trạng lên trang công khai hay
repo nguồn mở; `controlled` được chia ra ngoài sau soát xét; `internal` ở trong
không gian làm việc; `confidential` bao vật liệu nhạy cảm như hợp đồng, thông tin
xác thực và dữ liệu cá nhân. Thông tin xác thực thường nằm ngoài git, nhưng theo
mức vẫn là `confidential`.

> **Cổng hợp đồng phiên hoạt động trong checkout không dấu.** Phiên chưa ràng
> buộc được làm việc cục bộ thường ngày mà chính sách cho phép như kiểm tra,
> `npm test`, build, `mkdir`, và Git stage/commit thường không phá hủy. Tệp quản
> trị và chính sách host, điểm vào chung, hợp đồng phiên và thẩm quyền registry,
> xóa, lệnh phá hủy hay từ xa, hiệu ứng ra ngoài, và đổi production vẫn cần hợp
> đồng. Đây là kiểm tra quản trị của hook repo; không phải sandbox hệ điều hành
> và không bảo đảm các lệnh chạy ngoài hook. Xem
> `.agents/context/agents-rules.json` và `.agents/context/harness.yaml` để biết
> chính sách. Dấu `.codex/no-harness`, `.claude/no-harness` hay `.pi/no-harness`
> ở gốc dự án hoặc tổ tiên được checkout con cháu thừa hưởng. Ứng viên này nối
> hook hợp đồng phiên với Codex và Claude; nó không tuyên bố bộ chuyển Pi hợp
> đồng phiên.

### Bí mật nằm ở đâu

Không thể commit khóa API và chứng chỉ vào git. Nhưng giữ chúng chỉ trên từng
laptop nghĩa là mất khi đổi máy, và không ai nói được ai giữ gì. Naia ADK gỡ nút
này bằng cách chỉ commit **đúng một tệp**: thư mục bí mật, đóng gói và mã hóa.
Nội dung đã giải mã git không bao giờ thấy.

Cụ thể, thư mục `key/` được đóng tar và mã hóa bằng
[age](https://github.com/FiloSottile/age) thành một `key.age` duy nhất. `key/`
nằm trong `.gitignore` nên không thể bị commit nhầm. Thứ duy nhất từng vào commit
là `key.age`.

Một người gõ cụm mật khẩu. AI không nhận nó cũng không gõ thay ai. Việc mở và
niêm két diễn ra trong terminal của chính người dùng, trong khi kiểm tra và sao
lưu — vốn không cần cụm mật khẩu — có thể ủy thác. Ranh giới này được kẻ theo
từng lệnh bên trong skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` tồn tại vì lỗi có hình dạng cố định. Bạn thêm khóa rồi quên niêm, niêm
rồi quên đẩy, hay tệp tạm bị bỏ lại. `status` tìm cả ba cùng lúc. Khi ai hỏi khóa
đã sao lưu chưa, hãy trả lời bằng lệnh đó thay vì từ trí nhớ.

`lock` ghi bản mã mới, **giải mã lại để kiểm tra**, rồi mới thay tệp cũ — để lần
niêm dở dang không bao giờ để lại két hỏng.

Đối tượng dùng chuẩn của mẫu này là repo riêng như `data-private`, nhưng repo
nào có `key.age` và `key/` bị git bỏ qua cũng dùng được. Ghi đè `VAULT` và
`PLAIN_DIR` để đổi tên một trong hai phía.

### Bộ chuyển LLM (naia-anyllm)

Với tính năng cần với tới LLM, bộ chuyển `naia-anyllm` được tích hợp sẵn. Nó kết
nối qua cổng [any-llm](https://github.com/nextain/any-llm), hoặc trực tiếp tới
nhà cung cấp như OpenAI, Anthropic và Google. Mặc định là tài khoản Naia: đặt
khóa do [naia.nextain.io](https://naia.nextain.io) cấp vào biến môi trường
`NAIA_KEY` là bạn dùng ngay tín dụng tài khoản. Không khóa, nó báo lỗi trước mọi
cuộc gọi trả phí. Để đổi nhà cung cấp hay mô hình, sao chép
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example),
và giữ khóa API trong biến môi trường hay kho khóa hệ điều hành, không bao giờ
trong tệp cấu hình. `naia-settings/llm.json` chỉ ghi `apiKeyRef: "NAIA_KEY"`,
không bao giờ ghi giá trị khóa. Nếu fork cá nhân cần sao lưu dài hạn, dùng két
mã hóa age trong `data-private/key/` (xem [`.env.example`](.env.example)).

Để liệt kê mô hình được hỗ trợ và giá hiện tại, và để dịch PDF dài, dùng skill
`translate-doc`. Tra cứu mô hình và giá chạy không cần khóa; bản dịch hiện chi
phí ước tính trước và có thể tiếp tục từ chỗ dừng.

## Vì sao xây như vậy

### Định dạng chính là hợp đồng

Trái tim Naia ADK không phải công cụ cụ thể nào mà là một **định dạng**. Bố cục
thư mục (`.agents/`, `.users/`, `skills/`, `data-*/`) và lược đồ tệp
(`agents-rules.json`, `SKILL.md`) là thỏa thuận cố định, và công cụ nào đọc được
thỏa thuận đó đều dùng được cùng không gian làm việc. Claude Code, Codex,
opencode, naia-agent, agy và muse mỗi bên đọc cùng một không gian mà không nhúng
mã của nhau. Nhờ vậy bạn đổi công cụ hay trộn nhiều công cụ, không gian vẫn chạy.

Việc thực thi quy tắc cũng không phụ thuộc công cụ. Lõi trung lập host
(`.agents/hooks/core/`) và chính sách (`.agents/hooks/policies/`) dẫn cả hook
Claude Code lẫn phần mở rộng pi bằng cùng luật.

### Nền cá nhân trước khi lớn thành đội

Naia ADK hoàn toàn đơn người dùng, cho dùng cá nhân. Sơ đồ tổ chức công ty, quy
tắc tenant và chuỗi phê duyệt ủy quyền thuộc tầng cao hơn. Thứ nó cho bạn là một
nơi duy nhất để viết kỷ luật ngữ cảnh trước khi không gian lớn tới cỡ đội hay
công ty.

Để cộng tác đội và tri thức chung, bạn có thể chọn dòng tổ chức tùy chọn do
[Naia Business ADK](https://nextain.io/adk) đại diện. Nó thêm quản trị tài sản,
quy trình và quyền, sở hữu đội, và phê duyệt ủy quyền.

### Các dòng fork

Naia ADK sinh ra để fork thành không gian làm việc của riêng bạn. Cá nhân fork
`naia-adk` trực tiếp. Tổ chức có thể chọn dòng tổ chức riêng như
`naia-business-adk` cho không gian công ty và thành viên. Không ai bị đòi một
chuỗi cố định duy nhất.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

Dòng nội bộ của Nextain là ví dụ vận hành riêng. Người dùng công khai giữ fork
cá nhân trực tiếp và đặt tên `{user}-adk` theo tên tài khoản.

Nếu cần nền dự án/đội, bạn có thể chọn
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) làm nền riêng. PJ là nền
chuyển cho trôi ngữ cảnh đa dự án, chi phí gọi, và biên vận hành Discord. Tùy
biến fork cá nhân và quy tắc vai trò/giờ làm của đội là mối quan tâm riêng. Giúp
tổ chức và truy vết việc đó là mục tiêu thiết kế của cấu trúc này, không phải
bảo đảm đo được về tiết kiệm chi phí hay rút ngắn thời gian. Nền PJ không phải
repo cha của fork cá nhân. `naia-business-adk`, khi cần cộng tác tổ chức, là tùy
chọn.

## Cấu trúc

Repo chia thành mã runtime (`packages/`), quy tắc và ngữ cảnh (`.agents/`,
`.users/`), skill (`skills/`, `.agents/skills/`), và thư mục dữ liệu mỗi fork tự
điền.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | Ngữ cảnh cho AI (tiếng Anh, JSON/YAML) — nguồn sự thật duy nhất cho quy tắc |
| `.users/context/` | Hướng dẫn cho người đọc (tiếng Hàn, Markdown) |
| `.users/context/en/` | Gương tiếng Anh cho người đọc (Markdown) |
| `.claude/` | Cấu hình Claude Code, hook, symlink skill |
| `skills/` | Skill vận hành/runtime (API bảng điều khiển phục vụ) |
| `scripts/` | Kịch bản tiện ích |
| `templates/` | Mẫu tài liệu |
| `docs/` | Tài liệu kiến trúc, đặc tả thiết kế |
| `packages/` | Gói runtime (không gian pnpm) |
| `config/` | Hồ sơ worker mẫu và cấu hình triển khai |

### Gói runtime (packages/, tổng 12)

Ba gói là chương trình thật đang chạy; còn lại là gói mỏng định nghĩa định dạng
và đặc tả.

- `core` — máy phân tích không gian làm việc và skill.
- `server` — API REST/WebSocket Fastify.
- `dashboard` — giao diện Next.js của bảng.
- `skill-spec` — hợp đồng định dạng skill bất khả tri công cụ (`SkillDescriptor`,
  `SkillLoader`).
- `skills-builtin` — danh mục skill chung.
- `openclaw-compat` — công cụ chuyển skill OpenClaw sang định dạng naia.
- `persona` — đặc tả quy ước prompt hệ thống.
- `process` — đặc tả mẫu luồng việc (soát xét → quyết định → thực thi, phát triển
  theo issue, v.v.).
- `naia-anyllm` — bộ chuyển LLM qua cổng any-llm / nhà cung cấp trực tiếp.
- `artifacts-spec` — lược đồ chuẩn cho hiện vật phân quyền (RBAC) và vòng đời
  phát triển (SDLC). Định nghĩa 15 loại hiện vật bằng JSON Schema và nói rõ, với
  từng loại, phiên được git theo dõi hay giới hạn trong phiên.
- `ax-messenger` — gói chuyển tiếp/quản trị messenger Matrix (chuyển tiếp AI, sổ
  cái và nhà cung cấp trên `matrix-js-sdk`).
- `benchmark-contract` — hợp đồng benchmark và bằng chứng quản trị lâu dài dùng
  chung cho `naia-adk` và `naia-agent`.

### Bậc worker và ghi đè người soát

Vai trò và mô hình cấu hình riêng — không phiên bản mô hình nào bị nướng vào kiến
trúc.

- `config/tier-profile.example.json` (`tier-profile/v1`) là hồ sơ worker 4-bậc
  bất khả tri mô hình. Bậc mô tả *vai trò* (kiểm tra nhẹ, thiết kế và triển khai,
  phiên vai trò, soát độc lập); ứng viên mỗi bậc gắn CLI và mô hình riêng, nên
  đổi mô hình không bao giờ đổi cấu trúc vai trò.
- Ghi đè người soát cổng phê duyệt nằm trong `.claude/deploy/config.json` của
  phiên dưới dạng `review_models` (id người soát → mô hình chính xác, nỗ lực tối
  thiểu, runner). Chỉ लागू sau phê duyệt `CFG-`; không cấu hình được duyệt thì
  mặc định mã áp dụng. Runner gồm `agy`, `muse`, `codex` và `claude`. Xem
  [hướng dẫn cổng kế hoạch phê duyệt](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` giữ bảng soát liên repo và chính sách bậc mô hình
  mà skill `review-pass` và `naia-agent` dùng.

### Thư mục dữ liệu (gitignored, mỗi fork tự điền)

Bốn thư mục này không bao giờ commit. Ai fork repo thì điền dữ liệu của mình.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Tài liệu toàn công ty, tài nguyên chung |
| `data-teams/` | Team | Tài liệu đội (chiến lược, kế toán, v.v.) |
| `data-private/` | Personal | Dữ liệu cá nhân, tệp env, tài liệu riêng |
| `projects/` | Personal | Kho dự án (submodule) |

### Hai cây skill

Skill sống ở hai nơi, cho hai bên khác nhau dùng.

- `.agents/skills/` — skill hỗ trợ AI và luồng việc. Claude Code dùng qua symlink
  `.claude/skills/`. Gồm soát (`review-pass`), kiểm chứng
  (`verify-implementation`), hợp nhất worktree (`merge-worktree`), trích tài liệu
  (`read-doc`), skill nghiệp vụ như bằng sáng chế/bản quyền/lương, và các skill
  khác như `finetune-persona`, `secret-vault` và `youtube-upload`.
- `skills/` — skill vận hành/runtime. Máy chủ API quét `skills/**/SKILL.md` và
  phục vụ cho bảng. Gồm gửi email/SMS/thông báo, quản kênh, giám sát dịch vụ và
  web, và sinh tài liệu; `skills/business/` giữ skill tổ chức như `press-release`.

Danh sách chính xác nhất là danh mục skill trong bảng. Bảng văn bản ở
[chỉ mục skill](.agents/context/skills-index.yaml).

## Bắt đầu

### Cá nhân

1. Fork `naia-adk` vào tài khoản của bạn (riêng tư nếu được).
2. Nhân bản: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Thêm upstream: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Tạo thư mục dữ liệu: `mkdir -p data-private projects`
5. Thêm dự án, cấu hình `.agents/`, và bắt đầu làm.
6. Nếu dùng tài nguyên tài khoản Naia, đặt `NAIA_KEY` làm biến môi trường.
7. Đồng bộ định kỳ: `git fetch upstream && git merge upstream/main`

### Công ty

1. [Liên hệ chúng tôi](https://nextain.io/contact) để lấy quyền vào `naia-business-adk`.
2. Fork `naia-business-adk` riêng tư vào tài khoản tổ chức, rồi nhân bản.
3. Thêm upstream: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Điền dữ liệu công ty và submodule dự án: `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Mỗi thành viên fork lại ADK tổ chức thành không gian cá nhân.

### Tích hợp Naia Shell (tùy chọn)

Nếu dùng app desktop & web [Naia Shell](https://github.com/nextain/naia-shell),
trỏ đường dẫn không gian làm việc về thư mục ADK của bạn. Skill và dữ liệu được
phục vụ qua API.

## Đóng góp

Viết issue, PR và thảo luận bằng ngôn ngữ bạn thoải mái; AI làm trung gian giao
tiếp. Chỉ giữ hồ sơ git (commit, ngữ cảnh, hiện vật chung) bằng tiếng Anh. Quy
trình đầy đủ và quy tắc xem [CONTRIBUTING.md](CONTRIBUTING.md). Phát triển mặc
định theo issue; luồng chi tiết nằm ở [AGENTS.md](AGENTS.md),
[chỉ mục việc](.agents/context/ai-work-index.yaml),
[chỉ mục skill](.agents/context/skills-index.yaml), và
[`.agents/workflows/`](.agents/workflows/).

## Lộ trình

Mục dưới đã lên kế hoạch, chưa phải tính năng chạy hôm nay.

- **Knowledge atoms** — ngữ cảnh hôm nay dựa trên tệp, nên tìm một mẩu tin nghĩa
  là tải cả tệp và tốn token. Ý tưởng là chẻ ngữ cảnh thành đơn vị có nghĩa nhỏ
  nhất, nối bằng tag, và chỉ lấy đúng mẩu cần. Truy cập qua CLI hay MCP để giữ
  bất khả tri công cụ.

## Giấy phép & Thông báo bằng sáng chế

- **Mã (`Apache-2.0`):** theo [giấy phép Apache 2.0 (`Apache-2.0`)](LICENSE).
  Tự do dùng, sửa và phân phối — kể cả mục đích thương mại, dịch vụ lưu trữ hay
  quản lý trả phí (SaaS), và tổ chức mọi cỡ. Mục 3 giấy phép Apache 2.0 bao gồm
  giấy phép bằng sáng chế cho mã trong repo này.
- **Bằng sáng chế:** [`PATENTS.md`](PATENTS.md) giải thích ranh giới phạm vi
  khẳng định, liệt kê đơn bằng sáng chế của Nextain, và trao giao ước bằng sáng
  chế có điều kiện bổ sung (ngoài phạm vi đã cấp theo mục 3 giấy phép Apache 2.0)
  cho cá nhân, phi lợi nhuận và nhà phát triển hệ sinh thái Naia tuân thủ. Giao
  ước bổ sung này không bao việc thực hành bằng sáng chế niêm yết qua phương pháp
  hay mô-đun không chứa trong repo này trong dịch vụ lưu trữ trả phí cho bên thứ
  ba, sản phẩm đóng/OEM, hay triển khai toàn doanh nghiệp đạt hoặc vượt ngưỡng
  doanh thu hay ghế ở mục 2 [`PATENTS.md`](PATENTS.md); xem mục 2 và 3
  [`PATENTS.md`](PATENTS.md).
- **Thương mại:** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) bao mô-đun
  độc quyền Nextain Tier-2 và pipeline cloud không công bố trong repo này, giấy
  phép bằng sáng chế thương mại cho phương pháp không chứa ở đây, và hỗ trợ doanh
  nghiệp cùng bồi thường.
- **Đóng góp:** xem [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull request được nhận
  theo [`CLA.md`](CLA.md) (hoặc [`CLA-CORPORATE.md`](CLA-CORPORATE.md) cho đóng
  góp doanh nghiệp).

## Hệ sinh thái Naia

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (máy khách shell desktop & web)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (runtime tác tử & điều phối công cụ)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (bộ nhớ lâu dài của tác tử)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (trình biên dịch kho tri thức cho ngữ cảnh có cấu trúc)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)
