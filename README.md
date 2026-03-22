# The CPH-NG Project

> Quickly compile, run and judge competitive programming problems in VSCode.
> Automatically download testcases, or write & test your own problems.

This is the next generation of the
[Competitive Programming Helper](https://github.com/agrawal-d/cph).

![](https://github.com/user-attachments/assets/b4c100c4-43e1-48e0-a0c0-02b7b45758ba)

## License

This project is licensed under the terms of the [GNU Affero General Public License v3.0](https://github.com/langningchen/cph-ng/blob/main/LICENSE).

## Known Issues

See [GitHub Issues](https://github.com/langningchen/cph-ng/issues).

## Change Log

See [CHANGELOG.md](https://github.com/langningchen/cph-ng/blob/main/CHANGELOG.md)

## Basic Workflow

### 1. Install Both Components

- Install the `CPH-NG` VS Code extension.
- Install the `cph-ng-submit` browser extension in Chrome or Firefox.
- Open the browser extension popup once and make sure it is connected to the local router used by the VS Code extension.

### 2. Create or Import a Problem

- Open a source file in VS Code and use `CPH-NG: Create Problem` to create a fresh problem workspace.
- If you already have compatible problem metadata, use `CPH-NG: Import Problem` instead.
- After a problem is created or imported, CPH-NG manages testcases, limits, and related files from the problem panel.

### 3. Run Testcases and Stress Test

- Use `Run All Test Cases` from the problem panel to compile and run the current solution against the managed testcases.
- Add or edit testcases directly in the panel when you want to validate edge cases quickly.
- Use `Stress Test` to choose a generator and a brute-force solution, then let CPH-NG compare outputs until it finds a difference.

### 4. Use `cph-ng-submit`

- Keep the `cph-ng-submit` browser extension installed and connected.
- Open a supported online judge page in your browser.
- Click `Submit` in the CPH-NG problem panel to send the current source code through the local router to the browser extension.
- The browser extension opens the submission page and fills the code automatically on supported sites.
