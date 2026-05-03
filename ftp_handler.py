"""
TCloud - FTP Handler
Custom pyftpdlib FTP handler that uses the TCloud virtual filesystem.
"""

import logging

from pyftpdlib.handlers import FTPHandler

from ftp_filesystem import TCloudFilesystem
from ftp_authorizer import TCloudAuthorizer

logger = logging.getLogger("tcloud.ftp_handler")


class TCloudFTPHandler(FTPHandler):
    """
    Custom FTP handler that overrides the default filesystem
    with TCloud's virtual filesystem backed by MongoDB + Telegram.
    """

    # Override the abstracted_fs class to use our virtual filesystem
    abstracted_fs = TCloudFilesystem

    # Increase buffer sizes for better performance
    ac_in_buffer_size = 65536
    ac_out_buffer_size = 65536

    # Banner
    banner = "☁️ TCloud FTP Server - Telegram Cloud Storage"

    # Timeouts
    timeout = 300  # 5 min idle timeout
    passive_dtp_timeout = 60

    def on_connect(self):
        """Called when a new client connects."""
        logger.info(f"🔗 FTP connection from: {self.remote_ip}:{self.remote_port}")

    def on_disconnect(self):
        """Called when a client disconnects."""
        logger.info(f"🔌 FTP disconnect: {self.remote_ip}:{self.remote_port}")

    def on_login(self, username):
        """Called after successful login."""
        logger.info(f"✅ FTP login: {username} from {self.remote_ip}")

    def on_login_failed(self, username, password):
        """Called after failed login."""
        logger.warning(f"❌ FTP login failed: {username} from {self.remote_ip}")

    def on_logout(self, username):
        """Called when user logs out."""
        logger.info(f"👋 FTP logout: {username}")

    def on_file_sent(self, file):
        """Called when a file is successfully sent (RETR)."""
        logger.info(f"📥 FTP RETR complete: {file}")

    def on_file_received(self, file):
        """Called when a file is successfully received (STOR)."""
        logger.info(f"📤 FTP STOR complete: {file}")

    def on_incomplete_file_sent(self, file):
        """Called when a file transfer is interrupted (RETR)."""
        logger.warning(f"⚠️ FTP RETR incomplete: {file}")

    def on_incomplete_file_received(self, file):
        """Called when a file upload is interrupted (STOR)."""
        logger.warning(f"⚠️ FTP STOR incomplete: {file}")
