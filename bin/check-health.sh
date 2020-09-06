#!/bin/sh
if [ -e "/.running" ] ; then
  return 0
else
  return 1
fi
