#!/bin/sh

check_err(){
  if [ $1 -ne 0 ] ; then
    echo "[ERROR] $2"
    rm "/.running"
    exit 1
  fi
}

ssl_keygen(){
	local dir="/etc/truecommand"
	local cnffile="${dir}/ssl_tc.cnf"
	if [ ! -d "${dir}" ] ; then
		mkdir -p ${dir}
	fi
        if [ ! -e "${dir}/server.crt.auto" ] || [ ! -e "${cnffile}" ] ; then
		echo "Generate SSL Certificate"
		cp /etc/ssl/openssl.cnf ${cnffile}
		cat >${cnffile} <<EOF
[SAN]
subjectAltName=DNS:localhost
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no
[req_distinguished_name]
C = US
ST = MY
L = SomeCity
O = TrueCommand
OU = TrueCommand
CN = www.truecommand.io
EOF
		/usr/bin/openssl req -x509 -nodes -newkey rsa:2048 \
			-config ${dir}/crt.cnf \
		        -keyout ${dir}/server.key.auto \
		        -out ${dir}/server.crt.auto -days 9000 \
			-subj "/C=US/ST=MY/L=NULL/O=TrueCommand/OU=TrueCommand/CN=localhost/emailAddress=none@example.org" \
			-reqexts SAN -extensions SAN \
			-config ${cnffile} #2>/dev/null
	fi
	if [ -e "/data/truecommand/server.crt.custom" ] ; then
		# ensure custom cert/key are used
	        cp /data/truecommand/server.crt.custom ${dir}/server.crt
		cp /data/truecommand/server.key.custom ${dir}/server.key
	else
		# use the automatic cert/key
		cp ${dir}/server.crt.auto ${dir}/server.crt
		cp ${dir}/server.key.auto ${dir}/server.key
	fi
}

setup_datadir() {
	if [ ! -d "/data" ] ; then
		mkdir /data
	fi
	if [ ! -d "/data/ixdb" ] ; then
		# Init a fresh DB
		/etc/init.d/postgresql start
		createdb -h localhost -p 5432 -U postgres ixdb
		if [ -e "/data/ixdb.sql" ] ; then
			#Migration of database from other system
			su postgres -c "psql ixdb < /data/ixdb.sql"
			# Now rename the file so it is not used again later
			mv /data/ixdb.sql /data/ixdb.sql.orig
		fi
		/etc/init.d/postgresql stop

		# Move to correct /data location
		mv /var/lib/postgresql/11/main /data/ixdb
		chown postgres:postgres /data/ixdb
		ln -s /data/ixdb /var/lib/postgresql/11/main
		chown postgres:postgres /var/lib/postgresql/11/main
	else
		# Use existing database mounted into docker container
		rm -rf /var/lib/postgresql/11/main
		ln -s /data/ixdb /var/lib/postgresql/11/main
		chown postgres:postgres /var/lib/postgresql/11/main
	fi
	#Make sure to symlink any custom CA certificates from the data dir into the global directory
	if [ -d "/data/ssl" ] ; then
	  ln -s /data/ssl/*.pem /etc/ssl/certs/.
	fi
	#Need the data dir to be readable by the postgres user
	chmod 755 /data
}

setup_postgresql() {
	# Allow connection on localhost for ix_middleware
	cat >/etc/postgresql/11/main/pg_hba.conf <<EOF
# Database administrative login by Unix domain socket
local   all             postgres                                peer

# TYPE  DATABASE        USER            ADDRESS                 METHOD

# "local" is for Unix domain socket connections only
local   all             all                                     trust
# IPv4 local connections:
host    all             all             127.0.0.1/32            trust
# IPv6 local connections:
host    all             all             ::1/128                 trust
# Allow replication connections from localhost, by a user with the
# replication privilege.
local   replication     all                                     peer
host    replication     all             127.0.0.1/32            md5
host    replication     all             ::1/128                 md5
EOF
}

#Initial container setup
ssl_keygen
setup_postgresql
setup_datadir

touch "/.running"
echo "Starting Services [1/3]"
/etc/init.d/postgresql start
check_err $? "Could not start Postgresql!"

echo "Starting Services [2/3]"
/usr/sbin/nginx -c /etc/nginx-ix.conf
check_err $? "Could not start Nginx!"

echo "Starting Services [3/3]"
if [ -e "/data/ix_middleware.log" ] ; then
  mv -f "/data/ix_middleware.log" "/data/ix_middleware.log.old"
fi
/usr/bin/ix_middleware 2>&1 | tee -a "/data/ix_middleware.log"
rm "/.running"
