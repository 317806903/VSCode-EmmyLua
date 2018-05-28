import {
	LoggingDebugSession, Event, OutputEvent, TerminatedEvent, InitializedEvent, Breakpoint, StoppedEvent, StackFrame, Source, Thread, Variable, Handles
} from 'vscode-debugadapter';
import { DebugProtocol } from "vscode-debugprotocol";
import * as cp from "child_process";
import * as net from "net";
import * as sb from "smart-buffer";
import {
	LuaAttachMessage, DMReqInitialize, DebugMessageId, DMMessage, DMLoadScript, DMAddBreakpoint, DMBreak, StackNodeContainer, StackRootNode, LuaXObjectValue, IStackNode, DMReqEvaluate, EvalResultNode, DMRespEvaluate
} from './AttachProtol';
import { ByteArray } from './ByteArray';
import * as path from 'path';
import * as fs from 'fs';

var emmyToolExe:string, emmyLua: string;
var breakpointId:number = 0;

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	pid: number;
	extensionPath: string;
    sourcePaths: string[];
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
	private handles: Handles<IStackNode> = new Handles<IStackNode>();
	private evalIdCounter = 0;
	private evalMap = new Map<number, DebugProtocol.EvaluateResponse>();
    private sourcePaths: string[] = [];
	
	public constructor() {
		super("emmy_attach.txt");
		this.setDebuggerColumnsStartAt1(false);
		this.setDebuggerLinesStartAt1(false);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
		emmyToolExe = `${args.extensionPath}/server/windows/x86/emmy.tool.exe`;
		emmyLua = `${args.extensionPath}/server/Emmy.lua`;
		this.sourcePaths = args.sourcePaths;

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
			case DebugMessageId.RespEvaluate: msg = new DMRespEvaluate(); break;
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
					const filePath = this.resolvePath(mm.fileName);
					if (filePath) {
						this.sendEvent(new OutputEvent(`load:${mm.fileName}\n`));
						const script: LoadedScript = {
							path: filePath,
							index: mm.index
						};
						this.loadedScripts.set(filePath.toLowerCase(), script);
					} else {
						this.sendEvent(new OutputEvent(`file not found:${mm.fileName}\n`));
					}
					
					this.send(new LuaAttachMessage(DebugMessageId.LoadDone));
				}
				break;
			}
			case DebugMessageId.Break: {
				this.break = msg;
				this.sendEvent(new StoppedEvent("breakpoint", 1));
				break;
			}
			case DebugMessageId.RespEvaluate: {
				const evalResp = <DMRespEvaluate> msg;
				const response = this.evalMap.get(evalResp.evalId);
				if (response) {
					this.evalMap.delete(evalResp.evalId);
					response.body = {
						result: "TODO",
						variablesReference: 0
					};
					this.sendResponse(response);
				}
				break;
			}
			case DebugMessageId.SetBreakpoint: {
				break;
			}
			default: this.log(msg);
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
			const bpk = <DebugProtocol.Breakpoint> new Breakpoint(true, bp.line);
			bpk.id = ++breakpointId;
			breakpoints.push(bpk);
			
			bps.push({ id: breakpointId, line: bp.line });

			//send
			const script = this.findScript(path);
			if (script) {
				this.send(new DMAddBreakpoint(script.index, this.convertClientLineToDebugger(bp.line)));
			}
		});
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	private resolvePath(filePath: string): string | undefined {
		if (path.isAbsolute(filePath)) {
			if (fs.existsSync(filePath)) {
				return filePath;
			} else {
				return undefined;
			}
		}
		for (let index = 0; index < this.sourcePaths.length; index++) {
			const p = this.sourcePaths[index];
			const absPath = path.join(p, filePath);
			if (fs.existsSync(absPath)) {
				return absPath;
			}
		}
	}

	private findScript(path: string): LoadedScript | undefined {
		const filePath = this.resolvePath(path);
		if (filePath) {
			return this.loadedScripts.get(filePath.toLowerCase());
		}
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
			var index = 0;
			response.body = {
				stackFrames: stacks.children.map(child => {
					const root = <StackRootNode> child;
					const script = this.fundScriptByIndex(root.scriptIndex);
					var source: Source | undefined;
					if (script) {
						source = new Source(path.basename(script.path), this.resolvePath(script.path));
					}
					return new StackFrame(index, root.functionName, source, this.convertDebuggerLineToClient(root.line));
				}),
				totalFrames: stacks.children.length
			};
		}
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void
	{
		const stack = this.break!.stacks!.children[args.frameId];
		response.body = {
			scopes: [
				{
					name: "Local",
					variablesReference: this.handles.create(stack),
					expensive: false
				}
			]
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void
	{
		if (this.break) {
			const node = <StackNodeContainer> this.handles.get(args.variablesReference);
			response.body = {
				variables: node.children.map(node => {
					if (node instanceof LuaXObjectValue) {
						const vn = <LuaXObjectValue> node;
						return new Variable(vn.name, vn.data);
					}
					this.log(node);
					return new Variable("", "");
				})
			};
		}
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void
	{
		this.send(new LuaAttachMessage(DebugMessageId.Continue));
		this.sendResponse(response);
	}
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void
	{
		this.send(new LuaAttachMessage(DebugMessageId.StepOver));
		this.sendResponse(response);
	}
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void
	{
		this.send(new LuaAttachMessage(DebugMessageId.StepInto));
		this.sendResponse(response);
	}
	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
	{
		this.send(new LuaAttachMessage(DebugMessageId.StepOut));
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void
	{
		const id = this.evalIdCounter++;
		const stackId = args.frameId || 0;
		const req = new DMReqEvaluate(this.break!.L, id, stackId, args.expression);
		this.send(req);

		this.evalMap.set(id, response);
	}
}