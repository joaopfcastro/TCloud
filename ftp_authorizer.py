"""
TCloud - FTP Authorizer
Simple FTP authorizer using credentials from environment.
"""

import logging
from pyftpdlib.authorizers import DummyAuthorizer, AuthenticationFailed

from config import Config

logger = logging.getLogger("tcloud.ftp_auth")


class TCloudAuthorizer(DummyAuthorizer):
    """
    FTP Authorizer that uses FTP_USER/FTP_PASS from config.
    Grants full permissions to the virtual root.
    """

    def __init__(self):
        super().__init__()
        # 'elradfmwMT' = full permissions:
        # e=change dir, l=list, r=read, a=append, d=delete,
        # f=rename, m=mkdir, w=write, M=chmod, T=mtime
        self.add_user(
            Config.FTP_USER,
            Config.FTP_PASS,
            homedir="/",
            perm="elradfmwMT",
        )
        logger.info(f"👤 FTP user configured: {Config.FTP_USER}")

    def validate_authentication(self, username, password, handler):
        """Validate FTP login credentials."""
        if username == Config.FTP_USER and password == Config.FTP_PASS:
            logger.info(f"✅ FTP login: {username} from {handler.remote_ip}")
            return
        logger.warning(f"❌ FTP login failed: {username} from {handler.remote_ip}")
        raise AuthenticationFailed("Invalid username or password.")

    def get_home_dir(self, username):
        """Return home directory for user (always virtual root)."""
        return "/"

    def has_perm(self, username, perm, path=None):
        """Check if user has permission."""
        return True

    def get_perms(self, username):
        """Return all permissions for user."""
        return "elradfmwMT"

    def get_msg_login(self, username):
        """Login welcome message."""
        return f"Welcome to TCloud, {username}! ☁️"

    def get_msg_quit(self, username):
        """Quit message."""
        return "Goodbye from TCloud! 👋"
