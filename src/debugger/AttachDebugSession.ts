import {
	LoggingDebugSession, Event, OutputEvent, TerminatedEvent, InitializedEvent, Breakpoint, BreakpointEvent, StoppedEvent, StackFrame, Source, Thread
} from 'vscode-debugadapter';
import { DebugProtocol } from "vscode-debugprotocol";
import * as cp from "child_process";
import * as net from "net";
import * as sb from "smart-buffer";
import { LuaAttachMessage, DMReqInitialize, DebugMessageId, DMMessage, DMLoadScript, DMAddBreakpoint, DMBreak, StackNodeContainer, StackRootNode } from './AttachProtol';
import { ByteArray } from './ByteArray';
import { basename } from 'path';

var emmyToolExe:string, emmyLua: string;
var breakpointId:number = 0;

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	pid: number;
	extensionPath: string;
}

interface EmmyBreakpoint {
	id: number;
	line: number;
}

interface LoadedScript {
	path: string;
	index: number;
	source?: string;
}

export class AttachDebugSession extends LoggingDebugSession {

	private socket?: net.Socket;
	private receiveBuf = new sb.SmartBuffer();
	private expectedLen = 0;
	private breakpoints = new Map<string, EmmyBreakpoint[]>();
	private loadedScripts = new Map<string, LoadedScript>();
	private break?: DMBreak;
	
	public constructor() {
		super("emmy_attach.txt");
		this.setDebuggerColumnsStartAt1(false);
		this.setDebuggerLinesStartAt1(false);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
		emmyToolExe = `${args.extensionPath}/server/windows/x86/emmy.tool.exe`;
		emmyLua = `${args.extensionPath}/server/Emmy.lua`;

		let argList = [emmyToolExe, " ", "-m", "attach", "-p", args.pid, "-e", emmyLua];
		
		cp.exec(argList.join(" "), (err, stdout) => {
			if (err) {
				this.sendEvent(new OutputEvent(err.message));
			}
			if (stdout) {
				this.sendEvent(new OutputEvent(stdout));
				var lines = stdout.split("\n");
				lines.forEach(line => {
					if (line.startsWith("port:")) {
						var port = parseInt(line.substr(5));
						this.connect(port, response);
					}
				});
			}
		}).on("error", e => {
			this.sendEvent(new OutputEvent(e.message));
			this.sendEvent(new TerminatedEvent());
		});
	}

	connect(port: number, response: DebugProtocol.AttachResponse) {
		var socket = new net.Socket();
		socket.connect(port);
		socket.on("connect", () => {
			this.sendResponse(response);
			this.send(new DMReqInitialize("", emmyLua, true, true));
		}).on("data", buf => {
			this.receive(buf);
		}).on("error", (e) => {
			this.sendEvent(new OutputEvent(e.message));
			this.sendEvent(new TerminatedEvent());
		});
		this.socket = socket;
	}

	private send(msg: LuaAttachMessage) {
		if (this.socket) {
			let ba = new ByteArray();
			msg.write(ba);
			let buf = ba.toBuffer();
			let b2 = new ByteArray();
			b2.writeUint32(buf.length);
			this.socket.write(b2.toBuffer());
			this.socket.write(buf);
		}
	}

	private receive(buf: Buffer) {
		var pos = 0;
		while (pos < buf.length) {
			if (this.expectedLen === 0) {
				this.expectedLen = buf.readUInt32BE(pos);
				pos += 4;
			}
			var remain = buf.length - pos;
			var sizeToRead = remain > this.expectedLen ? this.expectedLen : remain;
			this.receiveBuf.writeBuffer(buf.slice(pos, pos + sizeToRead));
			pos += sizeToRead;
			this.expectedLen -= sizeToRead;
			if (this.expectedLen === 0) {
				this.handleMsgBuf(this.receiveBuf);
				this.receiveBuf.clear();
			}
		}
	}

	private handleMsgBuf(buf: sb.SmartBuffer) {
		var ba = new ByteArray(buf);
		var idValue = ba.readUint32();
		var id = idValue as DebugMessageId;
		var msg:LuaAttachMessage | undefined;
		switch (id) {
			case DebugMessageId.Message: msg = new DMMessage(); break;
			case DebugMessageId.LoadScript: msg = new DMLoadScript(); break;
			case DebugMessageId.Break: msg = new DMBreak(); break;
			default: msg = new LuaAttachMessage(id); break;
		}
		if (msg) {
			msg.read(ba);
			this.handleMessage(msg);
		} else {
			this.log(idValue);
		}
	}

	private handleMessage(msg: LuaAttachMessage) {
		switch (msg.id) {
			case DebugMessageId.RespInitialize: {
				this.sendEvent(new InitializedEvent());
				break;
			}
			case DebugMessageId.Message: {	
				let mm = msg as DMMessage;
				let text = mm.text;
				if (text) {
					this.sendEvent(new OutputEvent(`${text}\n`, "Attach"));
				}
				break;
			}
			case DebugMessageId.LoadScript: {
				let mm = msg as DMLoadScript;
				if (mm.fileName) {
					const path = this.normalizePath(mm.fileName);
					this.sendEvent(new OutputEvent(`${path}\n`));
					const script: LoadedScript = {
						path: path,
						index: mm.index
					};
					this.loadedScripts.set(path, script);
					this.send(new LuaAttachMessage(DebugMessageId.LoadDone));
				}
				break;
			}
			case DebugMessageId.Break: {
				this.break = msg;
				this.log(msg);
				this.sendEvent(new StoppedEvent("breakpoint", 1));
				break;
			}
			case DebugMessageId.SetBreakpoint: {
				break;
			}
			default:
			this.log(msg);
		}
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		if (this.socket) {
			this.socket.destroy();
			this.socket = undefined;
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(1, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		let lines = args.breakpoints || [];
		const path = <string> args.source.path;

		let bpList = this.breakpoints.get(path);
		if (!bpList) {
			bpList = new Array<EmmyBreakpoint>();
			this.breakpoints.set(path, bpList);
		}
		const bps = bpList;

		const breakpoints = new Array<DebugProtocol.Breakpoint>();
		lines.forEach(bp => {
			var bpk = <DebugProtocol.Breakpoint> new Breakpoint(true, bp.line);
			bpk.id = ++breakpointId;
			breakpoints.push(bpk);
			
			bps.push({ id: breakpointId, line: bp.line });

			//send
			const script = this.findScript(path);
			if (script) {
				this.send(new DMAddBreakpoint(script.index, bp.line));
			}
		});
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	private findScript(path: string): LoadedScript | undefined {
		path = this.normalizePath(path.substr("F:/ZeroBrane/".length));
		return this.loadedScripts.get(path);
	}

	private normalizePath(path: string) {
		return path.replace(/\\/g, "/");
	}

	private log(obj: any) {
		this.sendEvent(new Event("log", obj));
	}

	private fundScriptByIndex(index: number): LoadedScript|undefined {
		for (const iterator of this.loadedScripts) {
			if (iterator["1"].index === index) {
				return iterator["1"];
			}
		}
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		if (this.break) {
			const stacks = <StackNodeContainer> this.break.stacks;
			response.body = {
				stackFrames: stacks.children.map(child => {
					const root = <StackRootNode> child;
					const script = this.fundScriptByIndex(root.scriptIndex);
					var source = new Source("");
					if (script) {
						source.name = basename(script.path);
						source.path = "F:/ZeroBrane/" + script.path;
					}

					return <StackFrame> {
						id: 1,
						source: source,
						name: root.functionName,
						line: root.line,
					};
				}),
				totalFrames: stacks.children.length
			}
		}
		this.sendResponse(response);
	}
}