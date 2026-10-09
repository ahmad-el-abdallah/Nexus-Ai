"""Runs inside the sandbox, in front of an app or an install command.

The sandbox has no network of its own. This bridge is the only way in or out, and both
ends are Unix sockets that NEXUS owns:

  --serve SOCKET PORT   accept connections on SOCKET and pass them to 127.0.0.1:PORT
                        inside — how the owner's browser reaches a running app;
  --ready FILE          create FILE once that port accepts connections;
  --proxy PORT SOCKET   accept connections on 127.0.0.1:PORT inside and pass them to
                        SOCKET — how a package install reaches NEXUS's proxy, which
                        only connects to the package registries.

It then runs the command after `--` and exits with that command's exit code.
Standard library only: nothing of NEXUS is imported or visible here.
"""

import contextlib
import os
import signal
import socket
import subprocess
import sys
import threading
import time


def pump(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        with contextlib.suppress(OSError):
            target.shutdown(socket.SHUT_WR)


def relay(client, connect):
    try:
        upstream = connect()
    except OSError:
        client.close()
        return
    back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
    back.start()
    pump(client, upstream)
    back.join()
    client.close()
    upstream.close()


def accept(listener, connect):
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=relay, args=(client, connect), daemon=True).start()


def to_port(port):
    def connect():
        last = None
        for host in ("127.0.0.1", "::1"):
            try:
                connection = socket.create_connection((host, port), timeout=5)
                connection.settimeout(None)
                return connection
            except OSError as error:
                last = error
        raise last

    return connect


def to_socket(path):
    def connect():
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(path)
        return connection

    return connect


def announce(port, ready):
    connect = to_port(port)
    while True:
        try:
            connect().close()
        except OSError:
            time.sleep(0.2)
            continue
        with open(ready, "w") as handle:
            handle.write("ready\n")
        return


def main(argv):
    serve = proxy = ready = None
    index = 0
    while index < len(argv) and argv[index] != "--":
        option = argv[index]
        if option == "--serve":
            serve = (argv[index + 1], int(argv[index + 2]))
            index += 3
        elif option == "--proxy":
            proxy = (int(argv[index + 1]), argv[index + 2])
            index += 3
        elif option == "--ready":
            ready = argv[index + 1]
            index += 2
        else:
            raise SystemExit("bridge: unknown option " + option)
    command = argv[index + 1 :]
    if not command:
        raise SystemExit("bridge: no command given")

    if serve:
        path, port = serve
        with contextlib.suppress(OSError):
            os.unlink(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(64)
        threading.Thread(target=accept, args=(listener, to_port(port)), daemon=True).start()
        if ready:
            threading.Thread(target=announce, args=(port, ready), daemon=True).start()
    if proxy:
        port, path = proxy
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(64)
        threading.Thread(target=accept, args=(listener, to_socket(path)), daemon=True).start()

    process = subprocess.Popen(command)  # noqa: S603 - the command NEXUS chose, no shell
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: process.terminate())
    code = process.wait()
    sys.stdout.flush()
    os._exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main(sys.argv[1:])
