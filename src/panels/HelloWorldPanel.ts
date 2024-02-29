import mime from 'mime-types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

import getCredentials, { credentials } from '../utils/getCredentials';
import { getUri } from '../utils/getUri';
import { getNonce } from '../utils/getNonce';
import { logIn, logOut, download, upload } from '../utils/navigate';
import {
  getProblems,
  getRuns,
  getClarifications,
  getScore,
  getAllowedProgrammingLanguages,
  getProblemsIds,
} from '../utils/getData';

type message = { command: string };
type howdyMessage = { command: 'howdy'; text: string };
type loginMessage = { command: 'login'; credentials: credentials };
type downloadMessage = { command: 'download'; name: string; url: string };
type runsSubmitMessage = {
  command: 'runs-submit';
  problem: string;
  language: string;
  filePath: string;
};
type clarificationsSubmitMessage = {
  command: 'clarifications-submit';
  problem: string;
  question: string;
};

export class HelloWorldPanel {
  public static currentPanel: HelloWorldPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _secrets: vscode.SecretStorage;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    secrets: vscode.SecretStorage,
    extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    this._secrets = secrets;
    this._panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this._disposables,
    );
    this._panel.webview.html = this._getWebviewContent(
      this._panel.webview,
      extensionUri,
    );
    this._setWebviewMessageListener(this._panel.webview);
  }

  public static render(
    extensionUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ) {
    if (HelloWorldPanel.currentPanel) {
      HelloWorldPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'helloworld',
        'Hello World',
        vscode.ViewColumn.One,
        {
          // Enable javascript in the webview
          enableScripts: true,
          // Restrict the webview to only load resources from the `out` directory
          localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, 'out'),
            vscode.Uri.joinPath(
              extensionUri,
              'node_modules',
              '@vscode/codicons',
              'dist',
            ),
          ],
        },
      );

      HelloWorldPanel.currentPanel = new HelloWorldPanel(
        panel,
        secrets,
        extensionUri,
      );
    }
  }

  public dispose() {
    HelloWorldPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
  ) {
    const webviewUri = getUri(webview, extensionUri, [
      'out',
      'webview.js',
    ]).toString();
    const codiconsUri = getUri(webview, extensionUri, [
      'node_modules',
      '@vscode/codicons',
      'dist',
      'codicon.css',
    ]);

    const nonce = getNonce();

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: http:; script-src 'nonce-${nonce}';">
          <link href="${codiconsUri.toString(true)}" rel="stylesheet" />
          <title>Hello World!</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: message) => {
        switch (message.command) {
          case 'howdy': // howdy button was clicked
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            vscode.window.showInformationMessage(
              (message as howdyMessage).text,
            );
            return;
          case 'loaded': // window on load event has just been triggered
            await updateUI(this._secrets, this._panel);
            return;
          case 'login': // login form has been submitted
            const errorObject = await logIn(
              (message as loginMessage).credentials,
              this._secrets,
            );

            await updateUI(this._secrets, this._panel);

            if (errorObject === null) {
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              vscode.window.showInformationMessage('Logged in successfully!');
            } else {
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              vscode.window.showErrorMessage(
                `Login failed. Reason: ${errorObject.message}. Please try again.`,
              );
            }

            await this._panel.webview.postMessage({
              command: 'login-finished',
            });

            return;
          case 'logout': // logout button was clicked
            await logOut(this._secrets);
            await updateUI(this._secrets, this._panel);
            return;
          case 'download': // user clicked on a link to download a pdf
            const pathToSave =
              vscode.workspace.workspaceFolders === undefined
                ? // if VS Code doesn't have a opened directory, save file in cwd
                  // (i.e. the directory from which VS Code was opened from)
                  (message as downloadMessage).name
                : path.join(
                    vscode.workspace.workspaceFolders[0].uri.fsPath,
                    (message as downloadMessage).name,
                  );

            await download(
              (message as downloadMessage).url,
              pathToSave,
              this._secrets,
            );

            return;
          case 'runs-submit':
            const {
              problem: rProblem,
              language,
              filePath,
            } = message as runsSubmitMessage;
            const blob = new Blob(
              [readFileSync(filePath, { encoding: 'utf8', flag: 'r' })],

              // options.type is optional (defaults to '')
              // leave it undefined doesn't appear to break anything
              // however, it's being defined here just in case
              { type: mime.lookup(path.extname(filePath)) || '' },
            );

            const rBody = new FormData();
            rBody.append('confirmation', 'confirm');
            rBody.append('problem', rProblem);
            rBody.append('language', language);
            // may trigger warning `ExperimentalWarning: buffer.File is an experimental feature`;
            // as you can see here https://nodejs.org/api/buffer.html#class-file,
            // API is no longer experimental as of v20
            // (to check which Node version VS Code is running on, go to Help > About)
            rBody.append('sourcefile', blob, path.basename(filePath));
            rBody.append('Submit', 'Send');

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const rUploadHtmlResponse = await upload(
              this._secrets,
              'team/run.php',
              rBody,
            );
            console.log(rUploadHtmlResponse);

            await this._panel.webview.postMessage({
              command: 'runs-submitted',
            });

            return;
          case 'clarifications-submit':
            const { problem: cProblem, question } =
              message as clarificationsSubmitMessage;

            const cBody = new FormData();
            cBody.append('confirmation', 'confirm');
            cBody.append('problem', cProblem);
            cBody.append('message', question);
            cBody.append('Submit', 'Send');

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const cUploadHtmlResponse = await upload(
              this._secrets,
              'team/clar.php',
              cBody,
            );
            console.log(cUploadHtmlResponse);

            await this._panel.webview.postMessage({
              command: 'clarifications-submitted',
            });

            return;
          case 'pick-file': // 'Choose a file' button has been clicked
            const files = await vscode.window.showOpenDialog({
              openLabel: 'Select file',
              title: 'File dialog',
            });

            await this._panel.webview.postMessage({
              command: 'picked-file',
              path: files?.[0].fsPath,
            });

            return;
        }
      },
      undefined,
      this._disposables,
    );
  }
}

/**
 * post `update-ui` event to the webview; additionally,
 * if there're credentials stored, send some data for the webview to display
 */
async function updateUI(
  secrets: vscode.SecretStorage,
  panel: vscode.WebviewPanel,
) {
  const credentials = await getCredentials(secrets, false);

  if (credentials === null) {
    await panel.webview.postMessage({
      command: 'update-ui',
      credentials,
    });
    return;
  }

  const problems = await getProblems(secrets);
  const runs = await getRuns(secrets);
  const clarifications = await getClarifications(secrets);
  const score = await getScore(secrets);
  const allowedProgrammingLanguages =
    await getAllowedProgrammingLanguages(secrets);
  const problemsIds = await getProblemsIds(secrets);

  await panel.webview.postMessage({
    command: 'update-ui',
    credentials,
    problems,
    runs,
    clarifications,
    score,
    allowedProgrammingLanguages,
    problemsIds,
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function inspectSecretStorage(secrets: vscode.SecretStorage) {
  console.log({
    credentials: await secrets.get('credentials'),
    cookieJar: await secrets.get('cookieJar'),
  });
}
