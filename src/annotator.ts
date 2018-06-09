
import * as vscode from 'vscode';
import { IAnnotator, AnnotatorType } from './notifications';
import { LanguageClient } from 'vscode-languageclient';
import * as notifications from "./notifications";

let D_PARAM:vscode.TextEditorDecorationType;
let D_GLOBAL:vscode.TextEditorDecorationType;
let D_DOC_TYPE:vscode.TextEditorDecorationType;

function createDecoration(key: string): vscode.TextEditorDecorationType {
    let color = vscode.workspace.getConfiguration("emmylua").get(key);
    return vscode.window.createTextEditorDecorationType({
        light: {
            color: color
        },
        dark: {
            color: color
        }
    });
}

function updateDecorations() {
    D_PARAM = createDecoration("colors.parameter");
    D_GLOBAL = createDecoration("colors.global");
    D_DOC_TYPE = createDecoration("colors.doc_type");
}

export function onDidChangeConfiguration(client: LanguageClient) {
    updateDecorations();
}

let timeoutToReqAnn: NodeJS.Timer;

export function requestAnnotators(editor: vscode.TextEditor, client: LanguageClient) {
    clearTimeout(timeoutToReqAnn);
    timeoutToReqAnn = setTimeout(() => {
        requestAnnotatorsImpl(editor, client);
    }, 300);
}

function requestAnnotatorsImpl(editor: vscode.TextEditor, client: LanguageClient) {
    if (!D_PARAM) {
        updateDecorations();
    }

    let params:notifications.AnnotatorParams = { uri: editor.document.uri.toString() };
    client.sendRequest<notifications.IAnnotator[]>("emmy/annotator", params).then(list => {
        list.forEach(data => {
            let uri = vscode.Uri.parse(data.uri);
            vscode.window.visibleTextEditors.forEach((editor) => {
                let docUri = editor.document.uri;
                if (uri.path.toLowerCase() === docUri.path.toLowerCase()) {
                    updateAnnotators(editor, data);
                }
            });
        });
    });
}

function updateAnnotators(editor: vscode.TextEditor, annotator: IAnnotator) {
    switch (annotator.type) {
        case AnnotatorType.Param:
        editor.setDecorations(D_PARAM, annotator.ranges);
        break;
        case AnnotatorType.Global:
        editor.setDecorations(D_GLOBAL, annotator.ranges);
        break;
        case AnnotatorType.DocType:
        editor.setDecorations(D_DOC_TYPE, annotator.ranges);
        break;
    }
}