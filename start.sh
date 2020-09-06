#!/bin/sh
echo "Starting TrueCommand: $(date)"
export PATH="/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin"
/bin/startup-truecommand.sh
echo " - Finished: $(date)"
