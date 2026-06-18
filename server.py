import http.server, socketserver

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

with socketserver.TCPServer(("", 8000), NoCacheHandler) as httpd:
    print("Mira rodando em http://localhost:8000")
    httpd.serve_forever()
