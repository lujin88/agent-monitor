import Foundation
import AppKit
import ApplicationServices

// Read-only, metadata-only observer. No input, clicks, message text, cookies or credentials.
let targets: [String:String] = ["com.anthropic.claudefordesktop":"claude", "com.openai.chat":"gpt", "com.openai.codex":"gpt", "com.anysphere.sand":"grok", "com.google.Chrome":"browser", "com.apple.Safari":"browser"]
func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(e,name as CFString,&value) == .success ? value : nil }
func text(_ e: AXUIElement, _ name: String) -> String { return attr(e,name) as? String ?? "" }
func emit(_ object: [String:Any]) { if let d=try? JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]),let s=String(data:d,encoding:.utf8){print(s);fflush(stdout)} }
func locked() -> Bool { guard let d=CGSessionCopyCurrentDictionary() as? [String:Any] else { return false };return d["CGSSessionScreenIsLocked"] as? Bool == true }
let liveLabels:Set<String> = ["stop response","stop generating","stop responding","stop generation","claude is responding","停止响应","停止生成","停止回复"]
let readyLabels:Set<String> = ["send message","send now","send prompt","send","发送消息","发送","use voice mode","dictate"]
let waitLabels:Set<String> = ["allow once","allow this time","approve once","允许一次","仅允许一次"]
func snapshot() -> [String:Any] {
 if locked(){return ["health":"locked","accessGranted":AXIsProcessTrusted(),"windows":[]]}
 if !AXIsProcessTrusted(){return ["health":"permission_required","windows":[]]}
 var windows:[[String:Any]]=[]
 let deadline=Date().addingTimeInterval(7)
 var diagnostics:[[String:Any]]=[]
 for app in NSWorkspace.shared.runningApplications.sorted(by: {($0.bundleIdentifier == "com.anthropic.claudefordesktop" ? 0:1) < ($1.bundleIdentifier == "com.anthropic.claudefordesktop" ? 0:1)}) {
  if Date() > deadline {break}
  guard let bundle=app.bundleIdentifier,let appSource=targets[bundle] else {continue}
  let root=AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root,0.15)
  if appSource != "browser" {AXUIElementSetAttributeValue(root,"AXManualAccessibility" as CFString,kCFBooleanTrue)}
  guard let raw=attr(root,kAXWindowsAttribute) as? [AXUIElement] else {diagnostics.append(["source":appSource,"windowAccess":false]);continue}
  for (index,window) in raw.enumerated() {
   var queue:[AXUIElement]=[window],offset=0,count=0,live=false,ready=false,waiting=false,webURL="",webTitle="",hasComposer=false,conversationTitle=""
   let windowTitle=text(window,kAXTitleAttribute)
   while offset<queue.count && count<1800 && Date()<deadline {
    let e=queue[offset];offset+=1;count+=1
    let role=text(e,kAXRoleAttribute)
    if role=="AXWebArea" {
     let candidate=(attr(e,"AXURL") as? URL)?.absoluteString ?? text(e,"AXURL")
     let normalized=candidate.hasPrefix("http") || candidate.hasPrefix("file:") ? candidate : "https://"+candidate
     let h=URL(string:normalized)?.host?.lowercased() ?? ""
     let chatHost=["claude.ai","chatgpt.com","chat.openai.com","grok.com"].contains(h)
     if !chatHost && (appSource=="browser" || bundle=="com.openai.codex" || !h.isEmpty) {continue}
     if webURL.isEmpty && chatHost {webURL=normalized;webTitle=text(e,kAXTitleAttribute)}
    }
    // Only the named composer is evidence of a chat input, not arbitrary artifact fields.
    let description=text(e,kAXDescriptionAttribute), title=text(e,kAXTitleAttribute)
    if (role=="AXTextArea" || role=="AXTextField") && (description.lowercased().contains("prompt") || description.lowercased().contains("message") || description.lowercased().contains("ask") || appSource=="grok") {hasComposer=true}
    if role=="AXButton" {
     for label in [title,description] where label.hasSuffix(", rename chat") {conversationTitle=String(label.dropLast(", rename chat".count))}
    }
    // The response transcript and artifact bodies are not needed for status detection.
    if role=="AXGroup" && [title,description].contains("Chat messages") {continue}
    if role=="AXButton" || role=="AXStaticText" || role=="AXGroup" {
     var labels=[text(e,kAXTitleAttribute),text(e,kAXDescriptionAttribute),text(e,kAXHelpAttribute)]
     if role=="AXStaticText" {let value=text(e,kAXValueAttribute);if value.count<64{labels.append(value)}}
     for value in labels {let label=value.trimmingCharacters(in:.whitespacesAndNewlines).lowercased();if liveLabels.contains(label){live=true};if readyLabels.contains(label){ready=true};if role=="AXButton" && waitLabels.contains(label){waiting=true}}
    }
    if let children=attr(e,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children)}
   }
   diagnostics.append(["source":appSource,"scannedNodes":count,"completeScan":offset==queue.count,"liveControl":live,"readyControl":ready,"composer":hasComposer,"chatURL":!webURL.isEmpty])
   let url=URL(string:webURL),host=url?.host?.lowercased() ?? ""
   var source=appSource
   if appSource=="browser" || bundle=="com.openai.codex" {
    // Do not mistake a Codex coding task or an arbitrary web page for an ordinary chat.
    if host=="claude.ai"{source="claude"}else if host=="chatgpt.com" || host=="chat.openai.com"{source="gpt"}else if host=="grok.com"{source="grok"}else{continue}
   }
   if appSource=="grok" && !(host=="grok.com" || hasComposer) {continue}
   if !(live || (ready && hasComposer) || waiting){continue}
   let state=waiting ? "needs_action" : live ? "running" : "idle"
   let chatTitle = !conversationTitle.isEmpty ? conversationTitle : !webTitle.isEmpty ? webTitle.replacingOccurrences(of:" - Claude",with:"") : windowTitle
   // URL path identifies the selected chat; queries/fragments are deliberately excluded.
   let identity=host.isEmpty ? "\(bundle):\(app.processIdentifier):\(index):\(chatTitle)" : host+(url?.path ?? "/")
   windows.append(["source":source,"identity":identity,"title":chatTitle,"state":state,"completeScan":offset==queue.count,"identityReliable":!host.isEmpty || !["Claude","ChatGPT","Codex","Grok","Grok Bot", ""].contains(chatTitle),"surface":appSource=="browser" ? "browser":"desktop"])
  }
 }
 return ["health":"ok","accessGranted":true,"windows":windows,"diagnostics":diagnostics]
}
if CommandLine.arguments.contains("--request-access") {
 let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
 _ = AXIsProcessTrustedWithOptions(options)
}
emit(snapshot())
