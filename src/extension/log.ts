// The "Sidestory" output channel: why a file was refused, what failed. Nothing is sent anywhere.
import * as vscode from 'vscode';

export const log = vscode.window.createOutputChannel('Sidestory', { log: true });
