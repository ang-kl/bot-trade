// Codex · №11,968 · 2026-10-08; codex-footprint: real HTTP reader diagnostics regressions.
#include <cassert>
#include <csignal>
#include <cstdio>
#include <string>
#include <thread>
#include <atomic>
#include <functional>
#include <map>
#include <sys/wait.h>
#define private public
#include "../http_server.hpp"
#undef private
#include "../http_server.cpp"
static unsigned tests = 0;
struct Parsed { bool ok, tooLarge; HttpRequest request; ReadFailure failure; };
static Parsed exercise(const std::string& payload, bool eof = true) {
  int fds[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0);
  timeval timeout{0, 20000}; assert(setsockopt(fds[0], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout) == 0);
  std::thread writer([&] {
    size_t n = 0;
    while(n < payload.size()) { const auto s=send(fds[1],payload.data()+n,payload.size()-n,0); if(s<=0)break; n+=s; }
    if(eof) shutdown(fds[1],SHUT_WR);
  });
  Parsed result{}; result.ok=readRequest(fds[0],result.request,result.tooLarge,&result.failure);
  close(fds[0]); writer.join(); close(fds[1]); return result;
}
static void expect(const char* name, const std::string& bytes, const char* phase, const char* reason, bool eof=true) {
  const auto r=exercise(bytes,eof); assert(!r.ok); assert(r.failure.phase==phase); assert(r.failure.reason==reason);
  const auto line=incompleteReadLine(-1,r.failure,123);
  assert(line.find("phase="+std::string(phase))!=std::string::npos);
  assert(line.find("reason="+std::string(reason))!=std::string::npos);
  for(const auto* forbidden: {"FAKE_TOKEN","FAKE_QUERY","FAKE_BODY","Authorization","/fixture"})
    assert(line.find(forbidden)==std::string::npos);
  if(std::string(reason)=="timeout") assert(r.failure.socketErr==EAGAIN||r.failure.socketErr==EWOULDBLOCK);
  if(std::string(reason)=="eof") assert(r.failure.socketErr==0);
  ++tests; printf("PASS %s\n",name);
}
static void handler(const char* name, const char* flag, const std::string& payload,
                    const std::string& response, const std::string& diagnostic, bool eof=true, bool rateLimit=false) {
  int pair[2]; assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
  char path[]="/tmp/read-diagnostic-offline-XXXXXX"; const int captured=mkstemp(path); assert(captured>=0);
  const auto pid=fork(); assert(pid>=0);
  if(pid==0) {
    close(pair[1]); assert(dup2(captured,STDERR_FILENO)>=0);
    if(flag) setenv("HTTP_READ_DIAGNOSTICS",flag,1); else unsetenv("HTTP_READ_DIAGNOSTICS");
    timeval timeout{0,20000}; assert(setsockopt(pair[0],SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout)==0);
    HttpServer server(0,"local-fixture-only");
    server.route("POST","/fixture",[](const HttpRequest&){return HttpResponse{200,"{}"};});
    server.route("GET","/health",[](const HttpRequest&){return HttpResponse{200,"{}"};});
    server.handleClient(pair[0]);
    if(rateLimit) {
      int next[2]; assert(socketpair(AF_UNIX,SOCK_STREAM,0,next)==0); close(next[1]); server.handleClient(next[0]);
    }
    fflush(stderr); _exit(0);
  }
  close(pair[0]);
  if(!payload.empty()) assert(send(pair[1],payload.data(),payload.size(),0)==static_cast<ssize_t>(payload.size()));
  if(eof) shutdown(pair[1],SHUT_WR);
  std::string received; char b[4096];
  for(;;) { const auto n=recv(pair[1],b,sizeof b,0); if(n<=0)break; received.append(b,n); }
  close(pair[1]); int status=0; assert(waitpid(pid,&status,0)==pid); assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
  assert(lseek(captured,0,SEEK_SET)>=0); std::string logs;
  for(;;) { const auto n=read(captured,b,sizeof b); if(n<=0)break; logs.append(b,n); }
  close(captured); unlink(path);
  if(response.empty()) assert(received.empty()); else assert(received.find(response)!=std::string::npos);
  if(diagnostic.empty()) assert(logs.find("http: incomplete read")==std::string::npos);
  else assert(logs.find(diagnostic)!=std::string::npos);
  if(rateLimit) { const auto first=logs.find("http: incomplete read"); assert(first!=std::string::npos); assert(logs.find("http: incomplete read",first+1)==std::string::npos); }
  for(const auto* forbidden:{"FAKE_TOKEN","FAKE_QUERY","FAKE_BODY","Authorization","/fixture"}) assert(logs.find(forbidden)==std::string::npos);
  ++tests; printf("PASS %s\n",name);
}
int main() {
  signal(SIGPIPE,SIG_IGN);
  const std::string head="POST /fixture?FAKE_QUERY HTTP/1.1\r\nAuthorization: Bearer FAKE_TOKEN\r\nContent-Length: 12\r\n\r\n";
  expect("empty_eof","","headers","eof");
  expect("partial_header_eof","POST /fixture HTTP/1.1\r\nAuthorization: FAKE_TOKEN","headers","eof");
  expect("malformed_line","BAD\r\nAuthorization: FAKE_TOKEN\r\n\r\nFAKE_BODY","request_line","malformed");
  expect("partial_body_eof",head+"FAKE_BODY","body","eof");
  expect("header_timeout","","headers","timeout",false);
  expect("body_timeout",head+"FAKE_BODY","body","timeout",false);
  expect("header_cap",std::string((1<<20)+1,'x'),"headers","header_cap");
  expect("body_cap","POST /fixture HTTP/1.1\r\nContent-Length: 8388609\r\n\r\n","body","body_cap");
  {
    ReadFailure failure; HttpRequest request; bool large=false;
    assert(!readRequest(-1,request,large,&failure)); assert(failure.phase=="headers");
    assert(failure.reason=="recv_error"&&failure.socketErr==EBADF); ++tests; puts("PASS saved_recv_errno");
  }
  {
    const auto r=exercise(head+"FAKE_BODY"); assert(r.failure.headerBytes==head.size());
    assert(r.failure.bodyBytes==9); ++tests; puts("PASS exact_partial_byte_counts");
  }
  {
    const auto r=exercise(head+"FAKE_BODYabc"); assert(r.ok); assert(r.request.body=="FAKE_BODYabc");
    assert(r.request.path=="/fixture"&&r.request.query=="FAKE_QUERY"); assert(r.failure.reason.empty());
    ++tests; puts("PASS complete_request_preserved");
  }
  {
    const auto r=exercise("BAD\r\nAuthorization: FAKE_TOKEN\r\n\r\nFAKE_BODY");
    assert(r.failure.bodyBytes==9); ++tests; puts("PASS malformed_counts_do_not_mix_header_and_body");
  }
  handler("default_off",nullptr,head+"FAKE_BODY","","",true);
  handler("only_literal_one_enables","true",head+"FAKE_BODY","","",true);
  handler("opt_in_partial_body_redaction","1",head+"FAKE_BODY","","phase=body reason=eof",true);
  handler("opt_in_timeout_redaction","1","","","phase=headers reason=timeout",false);
  handler("auth_refusal_unchanged","1","POST /fixture HTTP/1.1\r\nAuthorization: Bearer FAKE_TOKEN\r\n\r\n","HTTP/1.1 401","",true);
  handler("auth_success_unchanged","1","POST /fixture HTTP/1.1\r\nAuthorization: Bearer local-fixture-only\r\n\r\n","HTTP/1.1 200","",true);
  handler("health_stays_open","1","GET /health HTTP/1.1\r\n\r\n","HTTP/1.1 200","",true);
  handler("413_response_preserved","1","POST /fixture HTTP/1.1\r\nContent-Length: 8388609\r\n\r\n","HTTP/1.1 413","reason=body_cap",true);
  handler("one_per_second_failure_limit","1",head+"FAKE_BODY","","phase=body reason=eof",true,true);
  {
    const int listener=socket(AF_INET,SOCK_STREAM,0); assert(listener>=0);
    sockaddr_in addr{}; addr.sin_family=AF_INET; addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(bind(listener,reinterpret_cast<sockaddr*>(&addr),sizeof addr)==0); assert(listen(listener,1)==0);
    socklen_t len=sizeof addr; assert(getsockname(listener,reinterpret_cast<sockaddr*>(&addr),&len)==0);
    const int client=socket(AF_INET,SOCK_STREAM,0); assert(client>=0);
    assert(connect(client,reinterpret_cast<sockaddr*>(&addr),sizeof addr)==0);
    const int accepted=accept(listener,nullptr,nullptr); assert(accepted>=0);
    sockaddr_in clientAddr{}; len=sizeof clientAddr; assert(getsockname(client,reinterpret_cast<sockaddr*>(&clientAddr),&len)==0);
    shutdown(client,SHUT_WR); ReadFailure failure; HttpRequest request; bool large=false;
    assert(!readRequest(accepted,request,large,&failure));
    const auto line=incompleteReadLine(accepted,failure,0);
    assert(line.find("peer=127.0.0.1 peer_port="+std::to_string(ntohs(clientAddr.sin_port)))!=std::string::npos);
    assert(line.find("local=127.0.0.1 local_port="+std::to_string(ntohs(addr.sin_port)))!=std::string::npos);
    close(accepted); close(client); close(listener); ++tests; puts("PASS exact_loopback_connection_tuple");
  }
  printf("%u offline parser/handler/metadata checks passed; no production cause asserted\n",tests);
}

