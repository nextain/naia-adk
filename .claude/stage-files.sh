#!/usr/bin/env bash

# Stage files for #204
cd "$(dirname "$0")/naia-os/shell"

# naia-os files
git add e2e/204-onboarding-login.spec.ts
git add src-tauri/Cargo.toml
git add src-tauri/src/browser.rs
git add src-tauri/tauri.conf.json
git add src/components/OnboardingWizard.tsx
git add src/components/SettingsTab.tsx
git add src/panels/browser/BrowserCenterPanel.tsx
git add .agents/progress/issue-204-onboarding-login.json

# naia.nextain.io files
cd "$(dirname "$0")/naia.nextain.io"
git add src/lib/deep-link.ts
git add src/lib/__tests__/deep-link.test.ts
git add 'src/app/[lang]/(auth)/callback/page.tsx'
git add src/app/desktop/auth-complete/page.tsx
git add src/i18n/dictionaries/types.ts
git add src/i18n/dictionaries/ar.ts
git add src/i18n/dictionaries/bn.ts
git add src/i18n/dictionaries/de.ts
git add src/i18n/dictionaries/es.ts
git add src/i18n/dictionaries/fr.ts
git add src/i18n/dictionaries/hi.ts
git add src/i18n/dictionaries/id.ts
git add src/i18n/dictionaries/ja.ts
git add src/i18n/dictionaries/ko.ts
git add src/i18n/dictionaries/pt.ts
git add src/i18n/dictionaries/ru.ts
git add src/i18n/dictionaries/vi.ts
git add src/i18n/dictionaries/zh.ts
