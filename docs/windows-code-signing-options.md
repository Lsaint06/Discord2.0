# Windows code signing for Discord 2.0 — options and recommendation

Investigation only: nothing was bought, no account was created and no Windows security setting
was changed. Prices and terms were checked on October 28–29, 2026 against the sources listed at the
end. Prices change, so re-check them before buying.

## Why we need it (evidence from this PC)

- **Smart App Control blocked both unsigned v1.4.0-rc.1 executables.** Code Integrity logged event
  3077, policy `VerifiedAndReputableDesktop`; see
  [v1.4.0-release-readiness.md](v1.4.0-release-readiness.md#smart-app-control).
  - Microsoft: Smart App Control runs an app only if its cloud service already knows the app as
    safe, or if it is signed with a certificate from a trusted provider.
  - Self-signed certificates don't count.
- **Only our executable is unknown to Windows.** In the packaged app:
  - `d3dcompiler_47.dll` and `dxil.dll` are signed by Microsoft;
  - `ffmpeg.dll`, `dxcompiler.dll`, `vk_swiftshader.dll` and `vulkan-1.dll` are unsigned, but
    byte-identical to the stock Electron files (checked by SHA-256). Stock files are widely
    distributed, which is presumably why they run;
  - `Discord2.exe` is Electron's `electron.exe` with our name, icon and version resources added.
    That makes it a brand-new file in every build, so Windows has no reputation for it and blocks it.
- **Signing the executable fixes the cause.** We should still sign the four Electron DLLs and the
  installer too: it costs nothing extra and doesn't depend on the stock files keeping their
  reputation.
- **What signing does not do:**
  - It doesn't make SmartScreen's "Windows protected your PC" prompt disappear immediately.
    Reputation builds per publisher over releases. EV certificates lost their instant bypass in 2024.
  - Whether Smart App Control accepts our *signed* build can only be verified once we have a
    certificate. Microsoft documents that it does.
- **Not acceptable:**
  - asking friends to turn Smart App Control off;
  - telling them to "unblock" the file;
  - self-signed certificates installed as trusted roots on their PCs.

## Options

| Option | Cost | Who can get it | What it needs | Publisher shown to users | Fit for us |
| --- | --- | --- | --- | --- | --- |
| **Azure Artifact Signing** (formerly Trusted Signing) — Microsoft's recommended route | **$9.99/month** (Basic: 5,000 signatures/month; more at $0.005 each). Billing starts when the account is created and isn't pro-rated. About $120/year | Individuals: **USA and Canada only** (organizations: also EU and UK) | Paid Azure subscription (free, trial and sponsored subscriptions are refused). Identity validation (government ID; a few business days, renewed periodically). No hardware: keys stay in Microsoft's cloud, certificates are short-lived and renewed automatically | Your **legal name** (no custom name allowed) | **Best fit if you live in the US or Canada.** Supported directly by our packager (electron-builder `win.azureSignOptions`) and by GitHub Actions |
| **Certum Open Source Code Signing in the Cloud** | **€49/year** (about $58 in Certum's US shop) | Individuals who publish **free / open-source** software, worldwide | Identity documents. The SimplySign phone app approves signing sessions and the SimplySign Desktop app provides a cloud "virtual card". 5,000 signatures/month | "Open Source Developer, *your name*" | **Cheapest**, but the repository needs an open-source license first (it has **none** today), and signing needs your phone each time, which is awkward in CI |
| **SignPath Foundation** | **Free** | Open-source projects that pass review | An OSI-approved license with no proprietary parts, an existing release, a documented download page, MFA on GitHub and SignPath, signing through their CI pipeline with release approval | "SignPath Foundation" | Possible only after adding a license; a public download page and review are required, and the "Discord" name may draw questions (our assumption, not their statement) |
| **OV certificate** from a commercial CA (DigiCert, Sectigo, GlobalSign, SSL.com…) | **$150–300/year** (Microsoft's estimate) | Anyone, worldwide | Identity validation. Since June 2023 the key must live in an HSM: a USB token or the CA's cloud signing. Certificates issued since March 1, 2026 last at most **460 days** (CA/Browser Forum ballot CSC-31) | Your name or organization | Works everywhere; costs the most for what we need |
| **EV certificate** | $400+/year | Anyone | As OV, stricter vetting | Organization | **Not worth it:** since 2024 it gets no SmartScreen advantage over OV |
| **Microsoft Store (MSIX)** | Free (free individual developer account); the Store re-signs the package | Worldwide | Store certification and a public listing. Converts the app to MSIX, which changes its identity and data folder (everyone signs in again), and may change how the tray, "open at sign-in" and portable builds behave | Microsoft (Store) | **Not recommended** for a private app for friends: public listing, and a name containing "Discord" is likely a trademark problem |

## Recommendation

1. **If you live in the US or Canada: Azure Artifact Signing**, about $10/month. It is cheapest per
   signed release among the hands-off options, needs no license change or hardware, and is
   supported by both electron-builder and GitHub Actions. Cancel it in months without releases
   (each month is billed in full).
2. **Otherwise, or to spend less: Certum Open Source** at €49/year. First choose and add an
   open-source license to the repository; MIT is the simplest. Only do this if you're comfortable
   with the code being formally open source. Expect to sign on your own PC with the phone approval
   (see the next section).
3. Either way, the certificate puts **your real name** into every signed file, where anyone can
   read it.

## How it would work in our build (after you pick an option)

- **Where to sign.** This PC isn't suitable for signing, for two reasons:
  1. Smart App Control already broke installer builds here: electron-builder runs the NSIS
     installer during the build, and the block made the build fail.
  2. electron-builder's Azure signing installs and runs a PowerShell module from the PowerShell
     Gallery, and PowerShell scripts are disabled on this PC by policy.

  Neither should be loosened. Build and sign on **GitHub Actions** (a `windows-latest` runner)
  instead. Certum's phone-approved cloud key is the exception: it is usually used from your own PC,
  which runs into reason 1.
- **electron-builder settings** (`desktop/electron-builder.yml`, Azure example):
  ```yaml
  win:
    azureSignOptions:
      publisherName: <your legal name, exactly as validated>
      endpoint: https://<region>.codesigning.azure.net
      codeSigningAccountName: <account>
      certificateProfileName: <profile>
    signExts: ['.dll']        # also sign Electron's DLLs
    forceCodeSigning: true    # a release build fails instead of shipping unsigned
  ```
  The credentials (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) go into GitHub
  Actions secrets, never into the repository.
- **Nothing changes for installed apps.** `appId` and the data folder stay the same (unlike MSIX),
  so the signed 1.4.0 upgrades 1.2.0 in place.
- **After building:**
  - run `Get-AuthenticodeSignature` on `Discord2.exe`, the DLLs, the installer and the uninstaller:
    every file must say `Valid`;
  - start it on a PC with Smart App Control on;
  - publish the SHA-256 hashes next to the files.

## What you would need to decide or provide

1. Your country of residence: decides Azure versus Certum or an OV certificate.
2. Whether your legal name may appear as the publisher.
3. For Certum or SignPath: whether to make the repository formally open source (add a `LICENSE`).
4. Budget approval and the identity-validation steps. These need your ID; only you can do them.
5. Approval to add a GitHub Actions release workflow, plus the repository secrets.

## Sources

- Microsoft Learn, *Sign your app for Smart App Control compliance* (updated September 28, 2026):
  https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
- Microsoft Learn, *Code signing options for Windows app developers* (costs, regions, EV change, Store):
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Microsoft Azure, *Artifact Signing pricing* (quotas, billing starts at account creation, no pro-rating):
  https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- Microsoft Learn, *Artifact Signing FAQ* (paid subscription required, legal name as CN, identity validation renewal):
  https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- Certum, *Open Source Code Signing in the Cloud* (requirements, "Open Source Developer" prefix, 5,000 signatures/month):
  https://shop.certum.eu/open-source-code-signing-on-simplysign.html. The €49 price comes from the
  Certum shop listing; the US-shop price and the no-commercial-use rule come from secondary
  summaries (my-ssl.com).
- SignPath Foundation, *Conditions for Open Source projects*: https://signpath.org/terms
- CA/Browser Forum, *Ballot CSC-31: Maximum Validity Reduction* (460 days from March 1, 2026):
  https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction/
- electron-builder 26.18.0 as installed in `desktop/node_modules`: the `azureSignOptions`,
  `signExts` and `forceCodeSigning` options, and the TrustedSigning PowerShell module used by
  Azure signing (`app-builder-lib/out/codeSign/windowsSignAzureManager.js`).
