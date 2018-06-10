'use strict';

import * as vscode from 'vscode';
import * as path from "path";
import * as net from "net";
import * as Annotator from "./annotator";
import * as notifications from "./notifications";
import findJava from "./findJava";
import { LanguageClient, LanguageClientOptions, ServerOptions, StreamInfo } from "vscode-languageclient";
import { Proposed } from 'vscode-languageserver-protocol';
import { AttachDebuggerProvider } from './debugger/AttachDebuggerProvider';
import { MobDebuggerProvider } from './debugger/MobDebuggerProvider';

const LANGUAGE_ID = 'lua'; //EmmyLua
export let savedContext: vscode.ExtensionContext;
let client: LanguageClient;
let activeEditor: vscode.TextEditor;
let progressBar: vscode.StatusBarItem;
let javaExecutablePath: string|null;

export function activate(context: vscode.ExtensionContext) {
    console.log("emmy lua actived!");
    savedContext = context;
    progressBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    javaExecutablePath = findJava();
    startClient();

    vscode.workspace.onDidChangeConfiguration(onDidChangeConfiguration, null, savedContext.subscriptions);
    vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument, null, savedContext.subscriptions);
    vscode.workspace.onDidChangeWorkspaceFolders(onDidChangeWorkspaceFolders, null, savedContext.subscriptions);
    vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor, null, savedContext.subscriptions);
    vscode.commands.registerCommand("emmy.restartServer", restartServer);
    vscode.commands.registerCommand("emmy.showReferences", showReferences);

    const attProvider = new AttachDebuggerProvider();
    savedContext.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("emmylua_attach", attProvider));
    savedContext.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("emmylua_launch", attProvider));
    savedContext.subscriptions.push(attProvider);
    const mobProvider = new MobDebuggerProvider();
    savedContext.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("emmylua_remote", mobProvider));
    savedContext.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("emmylua_remote_launch", mobProvider));
    savedContext.subscriptions.push(mobProvider);
    vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
        console.log(e.body);
    });
}

function asProtocol(workspaceFolder: vscode.WorkspaceFolder): Proposed.WorkspaceFolder {
    return { uri: workspaceFolder.uri.toString(), name: workspaceFolder.name };
}

function onDidChangeWorkspaceFolders(event: vscode.WorkspaceFoldersChangeEvent) {
    const params: Proposed.DidChangeWorkspaceFoldersParams = {
        event: {
            added: event.added.map(folder => asProtocol(folder)),
            removed: event.removed.map(folder => asProtocol(folder))
        }
    };
    client.sendNotification("emmy/didChangeWorkspaceFolders", params);
}

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
    if (activeEditor && activeEditor.document === event.document) {
        Annotator.requestAnnotators(activeEditor, client);
    }
}

function onDidChangeActiveTextEditor(editor: vscode.TextEditor|undefined) {
    if (editor === undefined) {
        return;
    }
    activeEditor = editor as vscode.TextEditor;
    Annotator.requestAnnotators(activeEditor, client);
}

// this method is called when your extension is deactivated
export function deactivate() {
    stopServer();
}

function onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent) {
    let shouldRestart = false;
    let newJavaExecutablePath = findJava();
    if (newJavaExecutablePath !== javaExecutablePath) {
        javaExecutablePath = newJavaExecutablePath;
        shouldRestart = true;
    }

    Annotator.onDidChangeConfiguration(client);

    if (shouldRestart) {
        restartServer();
    }
}

function startClient() {
    const clientOptions: LanguageClientOptions = {
        documentSelector: [ { scheme: 'file', language: LANGUAGE_ID } ],
        synchronize: {
            configurationSection: LANGUAGE_ID,
            fileEvents: [
                vscode.workspace.createFileSystemWatcher("**/*.lua")
            ]
        },
        initializationOptions: {
            stdFolder: vscode.Uri.file(path.resolve(savedContext.extensionPath, "res/std")).toString(),
            workspaceFolders: vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f.uri.toString()) : null,
        }
    };

    let socketMode = false;
    let serverOptions: ServerOptions;
    if (socketMode) {
        // The server is a started as a separate app and listens on port 5007
        const connectionInfo = {
            port: 5007
        };
        serverOptions = () => {
            // Connect to language server via socket
            let socket = net.connect(connectionInfo);
            let result: StreamInfo = {
                writer: socket,
                reader: socket as NodeJS.ReadableStream
            };
            socket.on("close", () => {
                console.log("client connect error!");
            });
            return Promise.resolve(result);
        };
    } else {
        const cp = path.resolve(savedContext.extensionPath, "server", "*");
        const exePath = javaExecutablePath || "java";
        console.log('exe path : ' + exePath);
        serverOptions = {
            command: exePath,
            args: ["-cp", cp, "com.tang.vscode.MainKt"]
        };
    }
    
    client = new LanguageClient(LANGUAGE_ID, "EmmyLua plugin for vscode.", serverOptions, clientOptions);
    client.onReady().then(() => {
        console.log("client ready");
        client.onNotification("emmy/progressReport", (d: notifications.IProgressReport) => {
            progressBar.show();
            progressBar.text = d.text;
            if (d.percent >= 1) {
                setTimeout(() => {
                    progressBar.hide();
                }, 3000);
            }
        });

        onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
    }).catch(reson => {
        vscode.window.showErrorMessage(`Failed to start "EmmyLua" language server!\n${reson}`, "Try again").then(item => {
            startClient();
        });
    });
    const disposable = client.start();
    savedContext.subscriptions.push(disposable);
}

function restartServer() {
    if (!client) {
        startClient();
    } else {
        client.stop().then(() => {
            startClient();
        });
    }
}

function showReferences(uri: string, pos: vscode.Position) {
    const u = vscode.Uri.parse(uri);
    const p = new vscode.Position(pos.line, pos.character);
    vscode.commands.executeCommand("vscode.executeReferenceProvider", u, p).then(locations => {
        vscode.commands.executeCommand("editor.action.showReferences", u, p, locations);
    });
}

function stopServer() {
    if (client) {
        client.stop();
    }
}