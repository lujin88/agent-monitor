import Foundation
import AppKit
import SQLite3
import CryptoKit

// No AX access, UI inspection, credential extraction, remote destinations, or body logging.
let claudeBundle = "com.anthropic.claudefordesktop"
let databasePath = NSHomeDirectory()+"/Library/Group Containers/group.com.apple.usernoted/db2/db"
let monitorRoot = NSHomeDirectory()+"/agent-monitor"
let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
enum ReaderError: Error { case access, schema, database, delivery }
// Diagnostics for the last failed open. errno distinguishes a macOS privacy (TCC) denial
// (EPERM, "Operation not permitted") from ordinary file permissions (EACCES) or a moved
// database (ENOENT). Previously every open failure was reported as Full Disk Access.
var openErrno: Int32 = 0
var openSQLiteCode: Int32 = 0
final class Database {
 var db: OpaquePointer?
 init(_ path: String) throws {
  // Metadata-free POSIX probe: open read-only, record errno, close immediately. Reads nothing.
  let probe=open(path,O_RDONLY)
  if probe<0 {openErrno=errno;throw ReaderError.access}
  close(probe)
  guard sqlite3_open_v2(path,&db,SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX,nil)==SQLITE_OK else { if db != nil {openSQLiteCode=sqlite3_extended_errcode(db);sqlite3_close(db)};db=nil;throw ReaderError.access }
  sqlite3_busy_timeout(db,750)
  guard sqlite3_exec(db,"PRAGMA query_only=ON",nil,nil,nil)==SQLITE_OK else {throw ReaderError.database}
 }
 deinit {if db != nil {sqlite3_close(db)}}
 func prepare(_ sql: String) throws -> OpaquePointer {
  var s: OpaquePointer?;guard sqlite3_prepare_v2(db,sql,-1,&s,nil)==SQLITE_OK,let statement=s else {throw ReaderError.schema};return statement
 }
 func columns(_ table: String) throws -> Set<String> {
  guard ["app","record"].contains(table) else {throw ReaderError.schema}
  let s=try prepare("PRAGMA table_info(\(table))");defer{sqlite3_finalize(s)};var cols=Set<String>()
  while sqlite3_step(s)==SQLITE_ROW {if let p=sqlite3_column_text(s,1){cols.insert(String(cString:p))}}
  return cols
 }
 func snapshot() throws -> (Int, [NotificationRecord]) {
  let cols=try columns("record")
  guard try columns("app").isSuperset(of:["app_id","identifier"]),cols.isSuperset(of:["app_id","data"]) else {throw ReaderError.schema}
  let apps=try prepare("SELECT COUNT(*) FROM app WHERE identifier = ?");defer{sqlite3_finalize(apps)}
  sqlite3_bind_text(apps,1,claudeBundle,-1,transient)
  guard sqlite3_step(apps)==SQLITE_ROW else{throw ReaderError.database}
  let appCount=Int(sqlite3_column_int(apps,0))
  // Only exact Claude app identifiers. Revision metadata and title/category detect
  // replaced or updated rows; SQLite rowid alone is not a notification cursor.
  let metadata=["uuid","request_date","request_last_date"].map { col in cols.contains(col) ? "COALESCE(hex(r.\(col)), '')" : "''" }.joined(separator:",")
  let s=try prepare("SELECT r.rowid,r.app_id,r.data,\(metadata) FROM record r JOIN app a ON a.app_id=r.app_id WHERE a.identifier = ? ORDER BY r.rowid LIMIT 10001");defer{sqlite3_finalize(s)}
  sqlite3_bind_text(s,1,claudeBundle,-1,transient)
  var rows:[NotificationRecord]=[]
  while true {
   let step=sqlite3_step(s);if step==SQLITE_DONE{break};guard step==SQLITE_ROW else{throw ReaderError.database}
   guard rows.count<10000 else{throw ReaderError.database} // Never silently discard a partial snapshot.
   let size=Int(sqlite3_column_bytes(s,2));var payload=Data()
   if size<=1048576,let raw=sqlite3_column_blob(s,2){payload=Data(bytes:raw,count:size)}
   let (title,category)=fields(payload)
   let values=(3...5).map { i -> String in guard let raw=sqlite3_column_text(s,Int32(i)) else{return ""};return String(cString:raw) }
   // No body hashing or persistence. Digest stays in RAM, never leaves this process.
   let revision=try JSONSerialization.data(withJSONObject:values+[title,category])
   let signature=SHA256.hash(data:revision).map{String(format:"%02x",$0)}.joined()
   let key="\(sqlite3_column_int64(s,1)):\(sqlite3_column_int64(s,0))"
   rows.append(NotificationRecord(key:key,signature:signature,title:title,category:category))
  }
  return (appCount,rows)
 }

}
func fields(_ payload: Data) -> (String,String) {
 // macOS stores the whole notification in a binary plist. Parse in memory, use
 // only title/category. Never inspect, retain, print, or forward body/userInfo.
 guard let root=(try? PropertyListSerialization.propertyList(from:payload,options:[],format:nil)) as? [String:Any] else{return ("","")}
 let req=(root["req"] as? [String:Any]) ?? root
 let title=(req["titl"] as? String) ?? (req["title"] as? String) ?? ""
 let category=(req["cate"] as? String) ?? (req["categoryIdentifier"] as? String) ?? (req["category"] as? String) ?? ""
 return (String(title.prefix(512)),String(category.prefix(128)))
}
func classify(title: String,category: String) -> String? {
 let t=title.trimmingCharacters(in:.whitespacesAndNewlines).lowercased(),c=category.lowercased()
 if t.contains("waiting for your input") || t.contains("needs your input") || ["waiting_for_input","needs_input"].contains(c){return "needs_action"}
 if ["task_completed","task_complete","response_completed","response_complete"].contains(c){return "done"}
 if ["task complete","task completed","task finished","response complete","response completed","claude finished the response","claude has finished","claude is done","ready for review"].contains(t){return "done"}
 if t.hasPrefix("task completed:") || t.hasPrefix("task complete:") || t.hasPrefix("claude has finished "){return "done"}
 return nil
}
final class LocalOnly: NSObject,URLSessionTaskDelegate {
 func urlSession(_ session: URLSession,task: URLSessionTask,willPerformHTTPRedirection response: HTTPURLResponse,newRequest request: URLRequest,completionHandler: @escaping (URLRequest?)->Void){completionHandler(nil)}
}
var generation=UUID().uuidString
func publish(id: Int64,kind: String) -> Bool {
 guard ["needs_action","done"].contains(kind),let key=try? String(contentsOfFile:monitorRoot+"/token.txt",encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines),!key.isEmpty else{return false}
 // Fixed loopback destination. No configurable host, proxy, DNS, redirects or remote requests.
 let configuration=URLSessionConfiguration.ephemeral;configuration.connectionProxyDictionary=[:];configuration.httpShouldSetCookies=false;configuration.urlCache=nil;configuration.timeoutIntervalForRequest=2
 let delegate=LocalOnly(),session=URLSession(configuration:configuration,delegate:delegate,delegateQueue:nil)
 var request=URLRequest(url:URL(string:"http://127.0.0.1:7777/event")!);request.httpMethod="POST";request.setValue(key,forHTTPHeaderField:"x-key");request.setValue("application/json",forHTTPHeaderField:"Content-Type")
 let event:[String:Any]=["source":"claude","session":"notification-\(generation)-\(id)","status":kind,"taskKind":"notification","stateSource":"macos-notification","title":kind=="done" ? "Claude reported completion":"Claude may need input","message":"Notification estimate. Chat or Cowork is not identified. Viewing the conversation may suppress notifications."]
 request.httpBody=try? JSONSerialization.data(withJSONObject:event)
 let signal=DispatchSemaphore(value:0);var success=false
 session.dataTask(with:request){_,response,error in success=error==nil && (response as? HTTPURLResponse)?.statusCode==200;signal.signal()}.resume()
 _=signal.wait(timeout:.now()+3);session.invalidateAndCancel();return success
}
func writeMetadata(_ filename: String,_ object: [String:Any]) {
 guard let data=try? JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]) else{return}
 let path=monitorRoot+"/"+filename
 do {try data.write(to:URL(fileURLWithPath:path),options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path)}catch{}
}
struct NotificationRecord {
 let key:String,signature:String,title:String,category:String
}
struct NotificationCursor {
 var seen:[String:String]?=nil
 mutating func changes(_ rows:[NotificationRecord]) -> [NotificationRecord] {
  let current=Dictionary(uniqueKeysWithValues:rows.map{($0.key,$0.signature)})
  guard let previous=seen else{seen=current;return []} // Launch baseline: no historical replay.
  seen=previous.filter{current[$0.key] != nil}
  return rows.filter{previous[$0.key] != $0.signature}
 }
 mutating func accept(_ record:NotificationRecord){seen?[record.key]=record.signature}
}
var cursor=NotificationCursor(),observed=0,ignored=0,waiting=0,completed=0,lastEventAt:Double?=nil
var pollCount=0,matchedApps=0,matchingRecords=0,baselineAt:Double?=nil
// Cursor and title/category signatures are memory-only. Persist only health counters.
func scan(probe: Bool=false) {
 var health="ready",schema:[String:[String]] = [:]
 openErrno=0;openSQLiteCode=0
 do {
  let db=try Database(databasePath)
  schema=["app":Array(try db.columns("app")).sorted(),"record":Array(try db.columns("record")).sorted()]
  let (appCount,rows)=try db.snapshot()
  matchedApps=appCount;matchingRecords=rows.count;pollCount+=1
  if probe {health="readable"}
  else {
   let first=cursor.seen==nil
   let changed=cursor.changes(rows)
   if first {baselineAt=Date().timeIntervalSince1970*1000}
   for record in changed {
    if let kind=classify(title:record.title,category:record.category){
     // Counter is stable across failed deliveries and unique even when rowids are reused.
     guard publish(id:Int64(observed+1),kind:kind) else{throw ReaderError.delivery}
     if kind=="done"{completed+=1}else{waiting+=1}
    }else{ignored+=1}
    observed+=1;lastEventAt=Date().timeIntervalSince1970*1000
    cursor.accept(record)
   }
   if appCount==0 {health="no_claude_notifications"}
  }
 }catch ReaderError.access{health = openErrno==EPERM ? "full_disk_access_required" : "database_open_failed"}
 catch ReaderError.schema{health="unsupported_schema"}
 catch ReaderError.delivery{health="dashboard_unreachable"}
 catch{health="database_unavailable"}
 var report:[String:Any]=["status":health,"checkedAt":Date().timeIntervalSince1970*1000,"databasePath":databasePath,"appIdentifier":claudeBundle,"observedSinceLaunch":observed,"ignoredSinceLaunch":ignored,"waitingSinceLaunch":waiting,"completedSinceLaunch":completed,"classification":"title-and-category-only","attribution":"Chat/Cowork unknown","network":"127.0.0.1:7777 only","mode":probe ? "probe":"watch"]
 report["readerVersion"]="2026-10-02-row-revisions"
 report["successfulPolls"]=pollCount;report["matchedAppRecords"]=matchedApps;report["matchingNotificationRecords"]=matchingRecords
 if let t=baselineAt{report["baselineAt"]=t}
 if let t=lastEventAt{report["lastNotificationAt"]=t}
 if !schema.isEmpty{report["schema"]=schema}
 // Launch ancestry is diagnostic context only. Parent PID alone does not establish
 // the TCC responsible process or prove which privacy permission applies.
 report["pid"]=Int(getpid());report["launchedBy"]=getppid()==1 ? "launchd" : "parent-process"
 report["bundlePath"]=Bundle.main.bundlePath
 if openErrno != 0 {report["openErrno"]=Int(openErrno);report["openError"]=String(cString:strerror(openErrno))}
 if openSQLiteCode != 0 {report["openSQLiteCode"]=Int(openSQLiteCode)}
 // A --probe run (usually from Terminal) writes its own file so it cannot overwrite the
 // background reader's health with a result that belongs to a different process.
 writeMetadata(probe ? "notification-reader-probe.json" : "notification-reader-status.json",report)
 if probe,let data=try? JSONSerialization.data(withJSONObject:report,options:.sortedKeys),let text=String(data:data,encoding:.utf8){print(text)}
}
if CommandLine.arguments.contains("--self-test") {
 assert(classify(title:"Waiting for your input",category:"")=="needs_action")
 assert(classify(title:"Task completed",category:"")=="done")
 assert(classify(title:"A title",category:"response_completed")=="done")
 assert(classify(title:"How do I know a task is complete?",category:"")==nil)
 let blob=try! PropertyListSerialization.data(fromPropertyList:["req":["titl":"A conversation","body":"waiting for your input PRIVATE BODY","cate":"unknown"]],format:.binary,options:0)
 let (title,category)=fields(blob);assert(title=="A conversation");assert(!title.contains("PRIVATE"));assert(classify(title:title,category:category)==nil)
 let temp=NSTemporaryDirectory()+"notification-fixture-"+UUID().uuidString+".db"
 var testdb:OpaquePointer?;assert(sqlite3_open(temp,&testdb)==SQLITE_OK)
 let setup="CREATE TABLE app(app_id INTEGER PRIMARY KEY,identifier TEXT); CREATE TABLE record(app_id INTEGER,data BLOB,uuid TEXT,request_date REAL,request_last_date REAL); INSERT INTO app VALUES(1,'com.anthropic.claudefordesktop'),(2,'unrelated.app'),(3,'com.anthropic.claudefordesktop'); INSERT INTO record VALUES(2,X'01','other',1,1),(1,X'02','initial',1,1),(2,X'03','other2',1,1);"
 assert(sqlite3_exec(testdb,setup,nil,nil,nil)==SQLITE_OK);sqlite3_close(testdb)
 func mutate(_ sql:String){var w:OpaquePointer?;assert(sqlite3_open(temp,&w)==SQLITE_OK);let rc=sqlite3_exec(w,sql,nil,nil,nil);assert(rc==SQLITE_OK,"Synthetic fixture mutation failed: \(rc) \(String(cString:sqlite3_errmsg(w)))");sqlite3_close(w)}
 func fixtureRows() throws -> [NotificationRecord]{try Database(temp).snapshot().1}
 do {
  let db=try Database(temp), (appCount,rows)=try db.snapshot()
  assert(appCount==2 && rows.count==1 && rows[0].key=="1:2")
  assert(sqlite3_exec(db.db,"DELETE FROM record",nil,nil,nil)==SQLITE_READONLY)
  var c=NotificationCursor()
  assert(c.changes(rows).isEmpty) // No history replay at startup.
  assert(c.changes(rows).isEmpty) // Unchanged notifications are not new events.
  mutate("UPDATE record SET request_last_date=2 WHERE rowid=2")
  let updated=try fixtureRows(), pending=c.changes(updated)
  assert(pending.count==1,"Updated notification row must be detected")
  assert(c.changes(updated).count==1,"Failed deliveries must remain retryable")
  c.accept(pending[0]);assert(c.changes(updated).isEmpty)
  let completion=try PropertyListSerialization.data(fromPropertyList:["req":["titl":"Task completed","body":"PRIVATE"]],format:.binary,options:0)
  let hex=completion.map{String(format:"%02x",$0)}.joined()
  mutate("UPDATE record SET data=X'\(hex)' WHERE rowid=2")
  let changedTitle=c.changes(try fixtureRows())
  assert(changedTitle.count==1 && classify(title:changedTitle[0].title,category:changedTitle[0].category)=="done")
  c.accept(changedTitle[0])
  let bodyChange=try PropertyListSerialization.data(fromPropertyList:["req":["titl":"Task completed","body":"DIFFERENT PRIVATE BODY"]],format:.binary,options:0).map{String(format:"%02x",$0)}.joined()
  mutate("UPDATE record SET data=X'\(bodyChange)' WHERE rowid=2")
  let bodyRows=try fixtureRows();assert(c.changes(bodyRows).isEmpty,"Bodies cannot be event evidence")
  mutate("DELETE FROM record WHERE rowid=2; INSERT INTO record(rowid,app_id,data,uuid,request_date,request_last_date) VALUES(2,1,X'02','replacement',3,3)")
  let reused=c.changes(try fixtureRows());assert(reused.count==1);c.accept(reused[0])
  mutate("INSERT INTO record(rowid,app_id,data,uuid,request_date,request_last_date) VALUES(1+10,3,X'02','second-app',4,4)")
  let newApp=c.changes(try fixtureRows());assert(newApp.count==1 && newApp[0].key=="3:11");c.accept(newApp[0])
  mutate("DELETE FROM record WHERE app_id IN (1,3)")
  let emptyRows=try fixtureRows();assert(c.changes(emptyRows).isEmpty)
  mutate("INSERT INTO record(rowid,app_id,data,uuid,request_date,request_last_date) VALUES(0,1,X'02','lower-rowid',5,5)")
  let lowerRows=try fixtureRows();assert(c.changes(lowerRows).count==1,"Lower rowids after cleanup must not be lost")
 }
 try? FileManager.default.removeItem(atPath:temp)
 print("Tests passed: exact app filter, read-only DB, startup baseline, in-place updates, row reuse, retry, deduplication, multiple app entries, title/category classification, body excluded.")
}else if CommandLine.arguments.contains("--probe"){scan(probe:true)}
else {
 let app=NSApplication.shared;app.setActivationPolicy(.accessory)
 let duplicates=NSWorkspace.shared.runningApplications.filter{$0.bundleIdentifier=="com.lu.agent-monitor.notifications" && $0.processIdentifier != getpid()}
 if duplicates.isEmpty {scan();let timer=Timer.scheduledTimer(withTimeInterval:3,repeats:true){_ in scan()};RunLoop.main.add(timer,forMode:.common);app.run()}
 else {FileHandle.standardError.write(("Another reader is already running (pid "+duplicates.map{String($0.processIdentifier)}.joined(separator:",")+"). Quit it before relaunching so a new permission grant takes effect.\n").data(using:.utf8)!)}
}
