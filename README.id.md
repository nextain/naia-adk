[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md) | [Português](README.pt.md) | **Bahasa Indonesia** | [Tiếng Việt](README.vi.md)

# Naia ADK

**Rangka ruang kerja yang sudah disiapkan untuk agen coding AI bekerja.**

Saat memakai perkakas coding AI seperti Claude Code atau Codex, setiap perkakas
menyimpan file aturannya di tempat berbeda, dan pertanyaan seperti “apakah dokumen
ini boleh dipublikasikan?” atau “skill ditaruh di mana?” dijawab secara ad hoc.
Naia ADK menyiapkan rangka itu di muka. Seperti menyiapkan lingkungan
pengembangan di laptop baru, ia menyerahkan meja kerja yang rapi kepada agen AI
untuk mulai bekerja. Ia juga menyediakan dasbor agar status ruang kerja terlihat
sekilas.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Jalan dalam 5 menit

Anda butuh **Node 22+** dan **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Buka `http://localhost:3142` di peramban untuk melihat dasbor. Tiga hal langsung
terlihat:

- **Workspace** — proyek dan submodule, pohon file, dan tingkat keterbukaan tiap
  item.
- **Skills catalog** — daftar skill yang terdaftar di ruang kerja ini, dan
  isinya.
- **Settings / monitoring** — konfigurasi server, status klien, direktori data.

Dasbor hanya meneruskan permintaan `/api/portal` tampilan docs ke server API di
port 3141. Untuk menjalankan salah satunya saja, gunakan `pnpm dev:server`
(→ 3141) atau `pnpm dev:dashboard` (→ 3142). Skrip peluncur `./start.sh`
(Linux/macOS) dan `start.bat` (Windows) sama-sama menjalankan `pnpm dev`. CLI
server menerima `--port`, `--host`, dan `--root`; misalnya, arahkan ke ruang
kerja lain dengan `pnpm serve -- --root /path/to/workspace`.

## Apa isinya

### Rangka ruang kerja

Ia memberi agen AI seperangkat direktori dengan tempat tetap untuk segalanya,
sehingga agen bisa langsung bekerja. Konteks untuk AI tinggal di `.agents/`
(Inggris, JSON/YAML). Panduan yang dibaca manusia tinggal di `.users/context/`
(Korea) dan `.users/context/en/` (Inggris). Cermin itu sebagian, bukan salinan
penuh — hanya berisi dokumen yang perlu dibaca manusia (misalnya, skill bersifat
kanonis di bawah `.agents/skills/`, dan hanya sebagian yang dicerminkan ke
`.users/skills/`). Skill, data, dan proyek semuanya punya lokasi tetap, sehingga
ruang kerja tampak sama apa pun perkakas yang membukanya.

### Dasbor dan API

Dasbor Next.js mengelola ruang kerja secara visual, didukung server API Fastify.
Tab **Docs** (`/docs`) dan **Work** di navigasi atas menampilkan dokumen bersama
perusahaan dan papan kolaborasi di satu tempat, dan
`pnpm adk:setup -- --company <repo-url>` menyiapkan repo dokumen perusahaan dan
proyek dalam satu langkah. Untuk detail penyiapan dan penggunaan, lihat
[panduan orientasi](docs/guides/onboarding.en.md)
([한국어](docs/guides/onboarding.ko.md)).
Lihat [panduan penulisan dokumentasi pengembangan](docs/guides/dev-docs-writing.en.md)
untuk mendokumentasikan arsitektur, kontrak, dan bukti implementasi.
API mengekspos metadata ruang kerja (`/api/workspace`), katalog skill
(`/api/skills`), portal dokumen perusahaan (`/api/portal`), dan WebSocket yang
mengalirkan peristiwa perubahan file (`/api/ws`). Berkat API ini, program selain
dasbor pun dapat menjangkau ruang kerja.

### Sistem skill

Tugas berulang dibundel menjadi skill yang dapat dipakai ulang. Setiap skill
didefinisikan oleh satu `SKILL.md`, dan server API memindai `skills/` untuk
membangun katalog. Jika satu saja skill melanggar format, seluruh katalog
melempar kesalahan (gagal-tertutup): alih-alih diam-diam membuang skill yang
rusak dan menyajikan sisanya, operator dipaksa memperbaikinya saat itu juga. Ini
pilihan sadar agar tidak mengirim katalog yang tidak lengkap secara tidak
sengaja.

### Apa yang ada di pohon skill hari ini

Skill terbagi dalam empat kelompok. Agar sesi tidak harus membaca ulang setiap
`SKILL.md` untuk tahu apa yang ada, `.agents/context/skills-index.yaml` memuat
satu baris per skill yang menyatakan apa fungsinya dan kapan menggunakannya.
Daftar di bawah adalah daftar isi indeks itu.

**Dokumen dan pekerjaan keluar** — hal yang akan dibaca orang.
`doc-coauthoring` (spesifikasi dan dokumen desain), `proposal-writing`,
`read-doc`, `translate-doc`, `press-release`, `weekly-report`,
`document-generation` (PDF bermerek dan tanda tangan digital), `copyright-reg`
(pendaftaran hak cipta), `patent-draft` dan `patent-pipeline` (spesifikasi
paten), `youtube-upload` (video dan subtitle).

**Menjalankan ruang kerja** — tangan yang menyentuh repo itu sendiri.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream` (sinkronisasi upstream), `manage-skills`, dan
`secret-vault` untuk brankas rahasia terenkripsi.

**Gerbang verifikasi** — tempat yang meminta bukti, bukan klaim.
`verify-implementation`, `verify-contract-conformance`, `verify-request-contract`,
`verify-product-preservation`, `verify-benchmark-contract`, `verify-review-gate`,
`verify-build` (apakah benar membangun), `verify-conflict-markers` (apakah marka
konflik tertinggal), `verify-i18n` dan `verify-hardcoded-strings` (apakah string
pada tempatnya), `webapp-testing`, dan `review-pass` untuk reviu adversarial.

**Operasi dan eksperimen** — pekerjaan yang menjangkau keluar atau menyentuh
model. `manage-discord-sessions` untuk gateway Discord, `channel-management`,
`service-management` (uptime, biaya, insiden), `web-monitoring`, `email`, `sms`,
`upstream-pr-review` (pintu sebelum apa pun sampai ke maintainer OSS),
`payroll`, dan `finetune-persona` untuk pelatihan LoRA persona.

Mulai skill baru dari `.agents/skills/SKILL_TEMPLATE.md`, dan tambahkan barisnya
ke indeks setelah ada. Saat indeks menyimpang dari pohon, sesi berikutnya
membangun ulang skill yang sudah dimilikinya.

### Aturan dan tata kelola minimum

Bahkan ruang kerja yang dipakai sendiri butuh aturan minimal begitu AI dan
otomasi menyentuhnya. Naia ADK memisahkan `read`, `write`, `execute`, dan
`publish` sebagai kepentingan berbeda, dan menempelkan tingkat keterbukaan pada
setiap dokumen. Tindakan yang sulit dibatalkan — perubahan produksi, penanganan
rahasia, klaim publik — dipisahkan dari edit lokal biasa dan diarahkan melalui
gerbang persetujuan.

Keterbukaan punya empat tingkat. `public` aman dikirim apa adanya ke situs publik
atau repo sumber terbuka; `controlled` boleh dibagikan ke luar setelah reviu;
`internal` tetap di dalam ruang kerja; `confidential` mencakup materi sensitif
seperti kontrak, kredensial, dan data pribadi. Kredensial biasanya tinggal di
luar git, tetapi secara tingkat tetap `confidential`.

> **Gerbang kontrak sesi aktif dalam checkout tanpa penanda.** Sesi yang tidak
> terikat boleh melakukan kerja lokal rutin yang diizinkan kebijakan seperti
> inspeksi, `npm test`, build, `mkdir`, dan Git stage/commit biasa yang tidak
> merusak. File tata kelola dan kebijakan host, entrypoint bersama, kontrak sesi
> dan otoritas registri, penghapusan, perintah destruktif atau jarak jauh, efek
> keluar, dan perubahan produksi tetap memerlukan kontrak. Ini pemeriksaan tata
> kelola hook repo; bukan sandbox sistem operasi dan tidak menjamin perintah yang
> diluncurkan di luar hook. Lihat `.agents/context/agents-rules.json` dan
> `.agents/context/harness.yaml` untuk kebijakannya. Penanda
> `.codex/no-harness`, `.claude/no-harness`, atau `.pi/no-harness` di root proyek
> atau leluhur diwarisi oleh checkout turunan. Kandidat ini menghubungkan hook
> kontrak sesi ke Codex dan Claude; ia tidak mengklaim adaptor Pi kontrak sesi.

### Tempat rahasia tinggal

Kunci API dan sertifikat tidak bisa di-commit ke git. Tetapi menyimpannya hanya
di tiap laptop berarti hilang saat mesin berganti, dan tak ada yang bisa bilang
siapa memegang apa. Naia ADK memutus simpul itu dengan meng-commit **tepat satu
file**: folder rahasia, diarsipkan dan dienkripsi. Isi yang terdekripsi tidak
pernah dilihat git sama sekali.

Concretely, folder `key/` di-tar dan dienkripsi dengan
[age](https://github.com/FiloSottile/age) menjadi satu `key.age`. `key/` ada di
`.gitignore`, sehingga tidak bisa ter-commit secara tidak sengaja. Satu-satunya
yang pernah mendarat di commit adalah `key.age`.

Seseorang mengetik frasa sandi. AI tidak menerimanya maupun mengetikkannya atas
nama siapa pun. Membuka dan menyegel brankas terjadi di terminal pengguna
sendiri, sedangkan pemeriksaan dan cadangan — yang tidak butuh frasa sandi —
dapat didelegasikan. Batas itu digambar perintah demi perintah di dalam skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` ada karena kesalahan punya bentuk tetap. Anda menambah kunci dan lupa
menyegel, atau menyegel dan lupa push, atau file sementara tertinggal. `status`
mencari ketiganya sekaligus. Saat ditanya apakah kunci dicadangkan, jawablah
dengan perintah itu, bukan dari ingatan.

`lock` menulis nuncript baru, **mendekripsinya lagi untuk memeriksa**, dan baru
mengganti file lama — sehingga penyegelan setengah jalan tidak pernah
meninggalkan brankas rusak.

Konsumen standar pola ini adalah repo pribadi seperti `data-private`, tetapi repo
mana pun dengan `key.age` dan `key/` yang diabaikan git dapat memakainya.
Timpa `VAULT` dan `PLAIN_DIR` untuk mengganti nama salah satu sisi.

### Adaptor LLM (naia-anyllm)

Untuk fitur yang perlu menjangkau LLM, adaptor `naia-anyllm` sudah bawaan. Ia
terhubung melalui gateway [any-llm](https://github.com/nextain/any-llm), atau
langsung ke penyedia seperti OpenAI, Anthropic, dan Google. Bawaannya akun Naia:
taruh kunci yang diterbitkan di [naia.nextain.io](https://naia.nextain.io) pada
variabel lingkungan `NAIA_KEY` dan Anda langsung dapat memakai kredit akun. Tanpa
kunci, ia melempar kesalahan sebelum panggilan berbayar apa pun. Untuk berganti
penyedia atau model, salin
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example),
dan simpan kunci API di variabel lingkungan atau keystore sistem operasi, jangan
pernah di file konfigurasi. `naia-settings/llm.json` hanya mencatat
`apiKeyRef: "NAIA_KEY"`, tidak pernah nilai kunci. Jika fork pribadi butuh
cadangan jangka panjang, gunakan brankas terenkripsi age di `data-private/key/`
(lihat [`.env.example`](.env.example)).

Untuk mendaftar model yang didukung dan harga terkini, dan untuk menerjemahkan
PDF panjang, gunakan skill `translate-doc`. Pencarian model dan harga bekerja tanpa
kunci; penerjemahan menampilkan estimasi biaya dulu dan dapat dilanjutkan dari
tempat berhenti.

## Mengapa dibangun seperti ini

### Format adalah kontrak

Jantung Naia ADK bukan perkakas tertentu melainkan sebuah **format**. Tata letak
direktori (`.agents/`, `.users/`, `skills/`, `data-*/`) dan skema file
(`agents-rules.json`, `SKILL.md`) adalah kesepakatan tetap, dan perkakas apa pun
yang dapat membaca kesepakatan itu dapat memakai ruang kerja yang sama. Claude
Code, Codex, opencode, naia-agent, agy, dan muse masing-masing membaca ruang kerja
yang sama tanpa menanamkan kode satu sama lain. Jadi Anda bisa berganti perkakas
atau mencampur beberapa, dan ruang kerja tetap berjalan.

Penegakan aturan itu sendiri pun agnostik-perkakas. Inti netral-host
(`.agents/hooks/core/`) dan kebijakan (`.agents/hooks/policies/`) menggerakkan
hook Claude Code maupun ekstensi pi dengan aturan yang sama.

### Basis pribadi sebelum tumbuh menjadi tim

Naia ADK mutlak satu pengguna, untuk pemakaian pribadi. Bagan org perusahaan,
aturan tenant, dan rantai persetujuan yang didelegasikan termasuk lapisan lebih
tinggi. Yang ia berikan adalah satu tempat untuk menulis disiplin konteks sebelum
ruang kerja tumbuh ke skala tim atau perusahaan.

Untuk kolaborasi tim dan pengetahuan bersama, Anda dapat memilih garis keturunan
organisasi opsional yang diwakili oleh
[Naia Business ADK](https://nextain.io/adk). Ia menambah tata kelola aset,
proses, dan izin, kepemilikan tim, dan persetujuan yang didelegasikan.

### Garis keturunan fork

Naia ADK dimaksudkan untuk di-fork ke ruang kerja Anda sendiri. Individu boleh
me-fork `naia-adk` langsung. Organisasi boleh memilih garis keturunan organisasi
terpisah seperti `naia-business-adk` untuk ruang kerja perusahaan dan anggota.
Tidak ada rantai tetap tunggal yang diwajibkan bagi pengguna mana pun.

```
naia-adk                  ← public personal base (Apache 2.0)
  └── {user}-adk          ← direct personal fork

naia-business-adk         ← optional organization lineage
  └── {org}-adk            ← org fork: company data + business submodules
        └── {member}-adk    ← member workspace derived from the organization
```

Garis keturunan internal Nextain adalah contoh operasi terpisah. Pengguna publik
boleh menyimpan fork pribadi langsung dan menamainya `{user}-adk` dengan nama
akun.

Jika butuh dasar proyek/tim, Anda dapat memilih
[naia-pj-adk](https://github.com/nextain/naia-pj-adk) sebagai dasar terpisah. PJ
adalah dasar adaptor untuk penyimpangan konteks multi-proyek, biaya pemanggilan,
dan batas operasi Discord. Penyesuaian fork pribadi dan aturan peran/jam kerja tim
adalah kepentingan terpisah. Membantu mengatur dan melacak pekerjaan itu adalah
tujuan desain struktur ini, bukan jaminan terukur atas penghematan biaya atau
waktu kerja lebih singkat. Dasar PJ bukan repo induk fork pribadi.
`naia-business-adk`, untuk saat butuh kolaborasi organisasional, bersifat
opsional.

## Struktur

Repo terbagi menjadi kode runtime (`packages/`), aturan dan konteks (`.agents/`,
`.users/`), skill (`skills/`, `.agents/skills/`), dan direktori data yang diisi
tiap fork.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | Konteks untuk AI (Inggris, JSON/YAML) — satu-satunya sumber kebenaran untuk aturan |
| `.users/context/` | Panduan yang dibaca manusia (Korea, Markdown) |
| `.users/context/en/` | Cermin Inggris yang dibaca manusia (Markdown) |
| `.claude/` | Konfigurasi Claude Code, hook, symlink skill |
| `skills/` | Skill operasional/runtime (disajikan API dasbor) |
| `scripts/` | Skrip utilitas |
| `templates/` | Templat dokumen |
| `docs/` | Dok arsitektur, spesifikasi desain |
| `packages/` | Paket runtime (ruang kerja pnpm) |
| `config/` | Contoh profil pekerja dan konfigurasi deploy |

### Paket runtime (packages/, total 12)

Tiga adalah program nyata yang berjalan; sisanya paket tipis yang mendefinisikan
format dan spesifikasi.

- `core` — mesin yang mengurai ruang kerja dan skill.
- `server` — API REST/WebSocket Fastify.
- `dashboard` — UI dasbor Next.js.
- `skill-spec` — kontrak format skill yang agnostik-perkakas (`SkillDescriptor`,
  `SkillLoader`).
- `skills-builtin` — katalog skill generik.
- `openclaw-compat` — perkakas yang memigrasi skill OpenClaw ke format naia.
- `persona` — spesifikasi konvensi prompt sistem.
- `process` — spesifikasi pola alur kerja (reviu → putuskan → eksekusi,
  pengembangan berbasis issue, dan seterusnya).
- `naia-anyllm` — adaptor LLM gateway any-llm / penyedia langsung.
- `artifacts-spec` — skema standar untuk artefak izin (RBAC) dan daur hidup
  pengembangan (SDLC). Ia mendefinisikan 15 tipe artefak sebagai JSON Schema dan
  menetapkan, untuk tiap-tiapnya, apakah instans dilacak git atau dibatasi sesi.
- `ax-messenger` — paket relai/admin messenger Matrix (relai AI, ledger, dan
  penyedia di atas `matrix-js-sdk`).
- `benchmark-contract` — kontrak benchmark permanen dan bukti tata kelola yang
  dipakai bersama oleh `naia-adk` dan `naia-agent`.

### Tingkat pekerja dan override pereviu

Peran dan model dikonfigurasi terpisah — tidak ada versi model yang dipanggang ke
arsitektur.

- `config/tier-profile.example.json` (`tier-profile/v1`) adalah profil pekerja
  4-tingkat yang agnostik-model. Tingkat menggambarkan *peran* (pemeriksaan ringan,
  desain dan implementasi, sesi peran, reviu independen); kandidat tiap tingkat
  mengikat CLI dan model secara terpisah, sehingga berganti model tidak pernah
  mengubah struktur peran.
- Override pereviu gerbang persetujuan tinggal di
  `.claude/deploy/config.json` instans sebagai `review_models` (id pereviu →
  model persis, upaya minimum, runner). Berlaku hanya setelah persetujuan `CFG-`;
  tanpa konfigurasi yang disetujui berlaku default kode. Runner mencakup `agy`,
  `muse`, `codex`, dan `claude`. Lihat
  [panduan gerbang rencana persetujuan](docs/guides/approval-plan-gate.en.md).
- `naia-settings/review.json` memuat panel reviu lintas-repo dan kebijakan tingkat
  model yang dikonsumsi skill `review-pass` dan `naia-agent`.

### Direktori data (gitignored, diisi per fork)

Keempat ini tidak pernah di-commit. Siapa pun yang me-fork repo mengisi datanya
sendiri.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Dokumen seluruh perusahaan, sumber daya bersama |
| `data-teams/` | Team | Dokumen tim (strategi, akuntansi, dll.) |
| `data-private/` | Personal | Data pribadi, file env, dokumen privat |
| `projects/` | Personal | Repo proyek (submodule) |

### Dua pohon skill

Skill tinggal di dua tempat, dikonsumsi pihak berbeda.

- `.agents/skills/` — skill asistensi AI dan alur kerja. Claude Code memakainya
  via symlink `.claude/skills/`. Termasuk reviu (`review-pass`), verifikasi
  (`verify-implementation`), gabungan worktree (`merge-worktree`), ekstraksi
  dokumen (`read-doc`), skill bisnis seperti paten/hak cipta/payroll, dan lainnya
  seperti `finetune-persona`, `secret-vault`, dan `youtube-upload`.
- `skills/` — skill operasional/runtime. Server API memindai `skills/**/SKILL.md`
  dan menyajikannya ke dasbor. Ini mencakup pengiriman email/SMS/notifikasi,
  manajemen kanal, pemantauan layanan dan web, dan pembuatan dokumen;
  `skills/business/` memuat skill org seperti `press-release`.

Daftar paling akurat adalah katalog skill di dasbor. Tabel teks ada di
[indeks skill](.agents/context/skills-index.yaml).

## Memulai

### Pribadi

1. Fork `naia-adk` ke akun Anda sendiri (privat bila bisa).
2. Klon: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Tambahkan upstream: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Buat direktori data: `mkdir -p data-private projects`
5. Tambahkan proyek, konfigurasikan `.agents/`, dan mulai bekerja.
6. Jika memakai sumber daya akun Naia, tetapkan `NAIA_KEY` sebagai variabel
   lingkungan.
7. Sinkronkan berkala: `git fetch upstream && git merge upstream/main`

### Perusahaan

1. [Hubungi kami](https://nextain.io/contact) untuk akses ke `naia-business-adk`.
2. Fork `naia-business-adk` secara privat ke akun organisasi, lalu klon.
3. Tambahkan upstream: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Isi data perusahaan dan submodule proyek: `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Tiap anggota me-fork lagi ADK org sebagai ruang kerja pribadi.

### Integrasi Naia Shell (opsional)

Jika memakai aplikasi desktop & web [Naia Shell](https://github.com/nextain/naia-shell),
arahkan path ruang kerjanya ke direktori ADK Anda. Skill dan data disajikan via
API.

## Berkontribusi

Tulis issue, PR, dan diskusi dalam bahasa yang Anda nyaman; AI memediasi
komunikasi. Jaga saja rekam git (commit, konteks, artefak bersama) dalam bahasa
Inggris. Untuk proses lengkap dan aturan, lihat [CONTRIBUTING.md](CONTRIBUTING.md).
Pengembangan baku berbasis issue; alur rinci ada di [AGENTS.md](AGENTS.md),
[indeks kerja](.agents/context/ai-work-index.yaml),
[indeks skill](.agents/context/skills-index.yaml), dan
[`.agents/workflows/`](.agents/workflows/).

## Peta jalan

Berikut ini direncanakan, bukan fitur yang berjalan hari ini.

- **Knowledge atoms** — konteks hari ini berbasis file, jadi menemukan satu
  informasi berarti memuat seluruh file dan membuang token. Idenya memecah
  konteks menjadi unit bermakna terkecil, menautkannya dengan tag, dan menarik
  hanya potongan tepat yang dibutuhkan. Akses lewat CLI atau MCP agar tetap
  agnostik-perkakas.

## Lisensi & Pemberitahuan Paten

- **Kode (`Apache-2.0`):** Dilisensikan di bawah [Lisensi Apache 2.0 (`Apache-2.0`)](LICENSE).
  Bebas dipakai, diubah, dan didistribusikan — termasuk untuk tujuan komersial,
  layanan hosting atau terkelola berbayar (SaaS), dan organisasi ukuran apa pun.
  Bagian 3 Lisensi Apache 2.0 mencakup lisensi paten untuk kode yang terkandung
  dalam repo ini.
- **Paten:** [`PATENTS.md`](PATENTS.md) menjelaskan pemisahan batas klaim,
  mendaftar permohonan paten Nextain, dan memberikan kovenan paten bersyarat
  tambahan (di luar cakupan yang sudah dilisensikan di bawah Bagian 3 Lisensi
  Apache 2.0) untuk individu, nirlaba, dan pengembang ekosistem Naia yang patuh.
  Kovenan tambahan itu tidak mencakup praktik atas paten terdaftar melalui metode
  atau modul yang tidak terkandung dalam repo ini dalam layanan hosting berbayar
  untuk pihak ketiga, produk tertutup/OEM, atau penyebaran seluruh perusahaan yang
  mencapai atau melampaui ambang pendapatan atau kursi di Bagian 2
  [`PATENTS.md`](PATENTS.md); lihat Bagian 2 dan 3 [`PATENTS.md`](PATENTS.md).
- **Komersial:** [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) mencakup modul
  berpemilik Nextain Tier-2 dan pipeline cloud yang tidak dipublikasikan di repo
  ini, lisensi paten komersial untuk metode yang tidak terkandung di sini, serta
  dukungan perusahaan dan ganti rugi.
- **Berkontribusi:** lihat [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull request
  diterima di bawah [`CLA.md`](CLA.md) (atau [`CLA-CORPORATE.md`](CLA-CORPORATE.md)
  untuk kontribusi korporat).

## Ekosistem Naia

- **naia-shell** — [github.com/nextain/naia-shell](https://github.com/nextain/naia-shell) (klien shell desktop & web)
- **naia-agent** — [github.com/nextain/naia-agent](https://github.com/nextain/naia-agent) (runtime agen & orkestrasi perkakas)
- **naia-memory** — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory) (memori agen persisten)
- **naia-kb-compiler** — [github.com/nextain/naia-kb-compiler](https://github.com/nextain/naia-kb-compiler) (kompiler basis pengetahuan untuk konteks terstruktur)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia** — [naia.nextain.io](https://naia.nextain.io)
