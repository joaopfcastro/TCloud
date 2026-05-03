"""
TCloud - Main Entry Point
Starts the FTP server with Telegram backend and MongoDB metadata store.
"""

import asyncio
import logging
import signal
import sys
from pathlib import Path

from pyftpdlib.servers import FTPServer

from config import Config
from telegram_client import TelegramManager
from database import Database
from file_manager import FileManager
from ftp_handler import TCloudFTPHandler
from ftp_authorizer import TCloudAuthorizer
from http_server import TCloudHTTPServer
from torrent_manager import TorrentManager


def setup_logging():
    """Configure logging with colored output."""
    log_format = (
        "%(asctime)s │ %(levelname)-8s │ %(name)-20s │ %(message)s"
    )
    date_format = "%Y-%m-%d %H:%M:%S"

    logging.basicConfig(
        level=getattr(logging, Config.LOG_LEVEL, logging.INFO),
        format=log_format,
        datefmt=date_format,
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
    )

    # Suppress noisy loggers
    logging.getLogger("telethon").setLevel(logging.WARNING)
    logging.getLogger("pyftpdlib").setLevel(logging.WARNING)


def print_banner():
    """Print TCloud startup banner."""
    banner = f"""
    ╔════════════════════════════════════════════════════╗
    ║                                                    ║
    ║   ████████╗ ██████╗██╗      ██████╗ ██╗   ██╗██████╗  ║
    ║   ╚══██╔══╝██╔════╝██║     ██╔═══██╗██║   ██║██╔══██╗ ║
    ║      ██║   ██║     ██║     ██║   ██║██║   ██║██║  ██║ ║
    ║      ██║   ██║     ██║     ██║   ██║██║   ██║██║  ██║ ║
    ║      ██║   ╚██████╗███████╗╚██████╔╝╚██████╔╝██████╔╝ ║
    ║      ╚═╝    ╚═════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═════╝  ║
    ║                                                    ║
    ║     ☁️  Telegram Cloud Storage via FTP  ☁️           ║
    ║     🎬  HTTP Streaming Server              ║
    ║     🚀  Native FUSE-T Virtual Drive        ║
    ║                                                    ║
    ╚════════════════════════════════════════════════════╝
    """
    print(banner)


async def start_services():
    """Initialize and start all TCloud services."""
    logger = logging.getLogger("tcloud.main")

    # Initialize Telegram
    telegram = TelegramManager()
    await telegram.start()

    # Initialize MongoDB
    db = Database()
    await db.connect()

    # Initialize File Manager
    file_manager = FileManager(telegram, db)
    
    # Initialize Torrent Manager
    torrent_manager = TorrentManager(file_manager)

    return telegram, db, file_manager, torrent_manager


async def cleanup_staging_loop(file_manager: FileManager):
    """Periodically clean up old staging files."""
    logger = logging.getLogger("tcloud.cleanup")
    while True:
        try:
            await asyncio.sleep(300)  # Every 5 minutes
            await file_manager.cleanup_staging()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Cleanup error: {e}")


async def cleanup_cache_loop(file_manager: FileManager):
    """Periodically run LRU cache eviction."""
    logger = logging.getLogger("tcloud.cache_cleanup")
    while True:
        try:
            await asyncio.sleep(600)  # Every 10 minutes
            await file_manager.cleanup_cache()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Cache cleanup error: {e}")


def run_ftp_server(file_manager: FileManager):
    """Configure and start the FTP server."""
    logger = logging.getLogger("tcloud.main")

    # Configure handler
    handler = TCloudFTPHandler
    handler.authorizer = TCloudAuthorizer()
    handler.passive_ports = Config.PASSIVE_PORTS

    # Attach file_manager to the server so the filesystem can access it
    server = FTPServer(
        (Config.FTP_HOST, Config.FTP_PORT),
        handler,
    )
    server.file_manager = file_manager
    server.max_cons = 256
    server.max_cons_per_ip = 10

    logger.info(f"🚀 FTP Server starting on {Config.FTP_HOST}:{Config.FTP_PORT}")
    logger.info(f"📡 Passive ports: {Config.PASSIVE_PORTS.start}-{Config.PASSIVE_PORTS.stop - 1}")
    logger.info(f"👤 FTP User: {Config.FTP_USER}")
    logger.info("=" * 50)
    logger.info("Ready! Connect with your FTP client.")
    logger.info("=" * 50)

    return server


async def main():
    """Main entry point."""
    # Load configuration
    Config.load()

    # Setup logging
    setup_logging()

    # Print banner
    print_banner()

    logger = logging.getLogger("tcloud.main")

    # Start services
    telegram, db, file_manager, torrent_manager = await start_services()

    # Start staging cleanup task
    cleanup_task = asyncio.create_task(cleanup_staging_loop(file_manager))

    # Start cache cleanup task
    cache_cleanup_task = asyncio.create_task(cleanup_cache_loop(file_manager))

    # Setup FTP server
    server = run_ftp_server(file_manager)

    # Handle graceful shutdown
    stop_event = asyncio.Event()

    def signal_handler(sig, frame):
        logger.info(f"\n🛑 Received signal {sig}, shutting down...")
        stop_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Run FTP server in a thread (it's synchronous)
    loop = asyncio.get_event_loop()
    server.loop = loop  # Attach loop for filesystem access
    ftp_task = loop.run_in_executor(None, server.serve_forever)

    # Start HTTP streaming server
    logger.info("Starting HTTP Server initialization...")
    http_server = TCloudHTTPServer(file_manager, torrent_manager=torrent_manager)
    logger.info("Calling http_server.start()...")
    http_runner = await http_server.start()
    logger.info(f"🎬 Open http://localhost:{Config.HTTP_PORT} in your browser to stream!")
    
    # Start FUSE Drive if enabled
    fuse_task = None
    if Config.FUSE_ENABLED:
        logger.info("Starting FUSE drive...")
        from fuse_drive import mount_fuse_drive
        fuse_task = asyncio.create_task(
            asyncio.to_thread(mount_fuse_drive, file_manager, loop)
        )
    else:
        logger.info("FUSE drive disabled by configuration (skipping).")

    try:
        # Wait for stop signal
        await stop_event.wait()
    finally:
        logger.info("🔄 Shutting down services...")

        # Stop FTP server
        server.close_all()

        # Cancel cleanup task
        cleanup_task.cancel()
        cache_cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        try:
            await cache_cleanup_task
        except asyncio.CancelledError:
            pass

        # Disconnect services
        await telegram.stop()
        await db.disconnect()

        # Stop HTTP server
        await http_runner.cleanup()

        logger.info("✅ TCloud shutdown complete. Goodbye! 👋")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 TCloud stopped.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\n❌ Fatal error: {e}", file=sys.stderr)
        sys.exit(1)
